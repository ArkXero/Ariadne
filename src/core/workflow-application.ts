import path from "node:path";
import fs from "fs-extra";
import { loadBatchFile, resolveBatchFile } from "./batch-reader.js";
import { createBatchId } from "./batch-persistence.js";
import { loadConfig, MAX_CONCURRENCY } from "./config.js";
import { AriadneError } from "./errors.js";
import { captureRepositorySnapshot } from "./git.js";
import { loadTasks } from "./task-loader.js";
import { rerunWorkflow, resumeWorkflow } from "./workflow-control.js";
import { WorkflowGraph } from "./workflow-graph.js";
import { buildWorkflowPlan } from "./workflow-planner.js";
import { runWorkflow } from "./workflow-runner.js";
import { WorkflowRuntimeChannel, type WorkflowRuntimeListener, type WorkflowRuntimeSnapshot } from "./workflow-runtime.js";
import { resultRefExists } from "./workspace-manager.js";
import type {
  BatchRecord, FailureCategory, FailureMode, IsolationStrategy, RetryPolicy, WorkflowPlan, WorkspaceMode
} from "../types/index.js";

export interface WorkflowExecutionOverrides {
  concurrency?: number;
  failureMode?: FailureMode;
  isolation?: IsolationStrategy;
  allowDirtyBase?: boolean;
}

export interface WorkflowCatalogTask {
  id: string;
  name: string;
  description?: string;
  group?: string;
  tags: string[];
  dependencies: string[];
  workspaceMode: WorkspaceMode;
  retry: RetryPolicy;
}

export interface WorkflowInspection {
  projectRoot: string;
  configPath: string;
  tasks: WorkflowCatalogTask[];
  defaults: Required<Pick<WorkflowExecutionOverrides, "concurrency" | "failureMode" | "isolation">> & { allowDirtyBase: false };
  sourceHead?: string;
  sourceDirty: boolean;
  dirtyPaths: string[];
  warnings: string[];
}

export interface WorkflowPlanBlocker {
  code: string;
  category: FailureCategory;
  message: string;
  correction: string;
}

export interface WorkflowPlanPreview extends WorkflowInspection {
  plan: WorkflowPlan;
  blockers: WorkflowPlanBlocker[];
}

export interface ResumeWorkflowPreview {
  kind: "resume";
  sourceBatchId: string;
  compatible: boolean;
  reusableTaskIds: string[];
  requeuedTaskIds: string[];
  plan?: WorkflowPlanPreview;
  blockers: WorkflowPlanBlocker[];
  warnings: string[];
}

export interface RerunWorkflowPreview {
  kind: "rerun";
  mode: "failed" | "failed-branch" | "all";
  sourceBatchId: string;
  selectedSourceTaskIds: string[];
  plan: WorkflowPlanPreview;
  warnings: string[];
}

export type WorkflowLaunchRequest =
  | ({ kind: "run"; cwd: string; configPath?: string; taskIds?: string[]; signal?: AbortSignal; onProgress?: (message: string) => void } & WorkflowExecutionOverrides)
  | ({ kind: "resume"; cwd: string; sourceBatchId: string; configPath?: string; signal?: AbortSignal; onProgress?: (message: string) => void } & Pick<WorkflowExecutionOverrides, "concurrency" | "allowDirtyBase">)
  | ({ kind: "rerun"; cwd: string; sourceBatchId: string; mode: "failed" | "failed-branch" | "blocked" | "all" | "tasks"; taskIds?: string[]; configPath?: string; signal?: AbortSignal; onProgress?: (message: string) => void } & WorkflowExecutionOverrides);

export interface WorkflowExecutionHandle {
  batchId: string;
  startedAt: string;
  completion: Promise<BatchRecord & { outputPath: string }>;
  subscribe(listener: WorkflowRuntimeListener): () => void;
  latestSnapshot(): WorkflowRuntimeSnapshot;
  requestCancellation(reason?: string): Promise<BatchRecord & { outputPath: string }>;
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function catalogTask(task: Awaited<ReturnType<typeof loadTasks>>[number], graph: WorkflowGraph): WorkflowCatalogTask {
  const tags = Array.isArray(task.metadata?.tags)
    ? task.metadata.tags.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0).map((tag) => tag.trim())
    : [];
  return {
    id: task.id,
    name: task.name,
    ...(metadataString(task.metadata, "description") ? { description: metadataString(task.metadata, "description") } : {}),
    ...(metadataString(task.metadata, "group") ? { group: metadataString(task.metadata, "group") } : {}),
    tags,
    dependencies: [...graph.dependencyIds(task.id)],
    workspaceMode: task.workspaceMode,
    retry: { ...task.retry }
  };
}

async function sourceBatch(cwd: string, batchId: string): Promise<{ batch: BatchRecord; warnings: string[] }> {
  const filePath = await resolveBatchFile(cwd, batchId);
  const loaded = await loadBatchFile(filePath, cwd);
  if (!loaded.ok) throw new AriadneError({
    category: loaded.code === "missing" ? "task_selection" : "persistence",
    code: loaded.code === "missing" ? "BATCH_NOT_FOUND" : "BATCH_RECORD_UNREADABLE",
    stage: "loading", source: filePath, message: loaded.error,
    correction: "Choose a valid batch ID from ariadne list --batches."
  });
  return { batch: loaded.batch, warnings: loaded.warnings };
}

async function inspectionParts(cwd: string, configPath?: string): Promise<{ inspection: WorkflowInspection; config: Awaited<ReturnType<typeof loadConfig>>["config"]; graph: WorkflowGraph; repository: Awaited<ReturnType<typeof captureRepositorySnapshot>> }> {
  const loaded = await loadConfig(cwd, configPath);
  const tasks = await loadTasks(loaded.projectRoot, loaded.config.tasks.directory, loaded.config.sourceVersion);
  const graph = new WorkflowGraph(tasks);
  const repository = await captureRepositorySnapshot(loaded.projectRoot, [".ariadne"]);
  const dirtyEntries = repository.entries.filter((entry) => entry.changeType !== "ignored");
  return {
    inspection: {
      projectRoot: loaded.projectRoot,
      configPath: path.relative(loaded.projectRoot, loaded.path).split(path.sep).join("/"),
      tasks: graph.tasks.map((task) => catalogTask(task, graph)),
      defaults: {
        concurrency: loaded.config.execution.concurrency,
        failureMode: loaded.config.execution.failure_mode,
        isolation: loaded.config.execution.isolation,
        allowDirtyBase: false
      },
      sourceHead: repository.head,
      sourceDirty: repository.dirty,
      dirtyPaths: dirtyEntries.map((entry) => entry.path),
      warnings: [...loaded.warnings]
    },
    config: loaded.config,
    graph,
    repository
  };
}

export async function inspectWorkflowOptions(options: { cwd: string; configPath?: string }): Promise<WorkflowInspection> {
  return (await inspectionParts(options.cwd, options.configPath)).inspection;
}

export async function createWorkflowPlanPreview(options: { cwd: string; configPath?: string; taskIds?: string[] } & WorkflowExecutionOverrides): Promise<WorkflowPlanPreview> {
  const { inspection, config, graph, repository } = await inspectionParts(options.cwd, options.configPath);
  const concurrency = options.concurrency ?? config.execution.concurrency;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) throw new AriadneError({
    category: "configuration", code: "WORKFLOW_CONCURRENCY_INVALID", stage: "validated", fieldPath: "concurrency", offendingValue: concurrency,
    expected: `An integer from 1 through ${MAX_CONCURRENCY}.`, message: `Workflow concurrency must be between 1 and ${MAX_CONCURRENCY}.`,
    correction: `Choose concurrency 1..${MAX_CONCURRENCY}.`
  });
  const plan = buildWorkflowPlan({
    graph, config, selectedIds: options.taskIds, concurrency,
    failureMode: options.failureMode, isolation: options.isolation,
    dirtyBaseAcknowledged: options.allowDirtyBase
  });
  const blockers: WorkflowPlanBlocker[] = [];
  if (!repository.available && (config.checks.max_changed_files !== undefined || config.checks.max_diff_lines !== undefined)) blockers.push({
    code: "GIT_REQUIRED_FOR_POLICIES", category: "repository_validation", message: "Git repository state is unavailable, but changed-file or diff-line policies are configured.",
    correction: "Run inside a Git repository or remove Git-dependent limits."
  });
  if (plan.isolation === "worktree" && (!repository.available || !repository.head)) blockers.push({
    code: "WORKTREE_SOURCE_REQUIRED", category: "workspace_management", message: "Worktree isolation requires a Git repository with a committed HEAD.",
    correction: "Commit the source revision or choose shared isolation."
  });
  if (plan.isolation === "worktree" && repository.dirty && !plan.dirtyBaseAcknowledged) blockers.push({
    code: "DIRTY_WORKTREE_BASE", category: "repository_validation", message: "The primary checkout is dirty; isolated worktrees use committed HEAD only.",
    correction: "Commit or clean the checkout, choose shared isolation, or explicitly acknowledge the excluded changes."
  });
  const warnings = [...inspection.warnings];
  if (plan.isolation === "worktree" && repository.dirty) warnings.push(`Dirty primary checkout: ${inspection.dirtyPaths.join(", ") || "Git-visible changes detected"}.`);
  return { ...inspection, warnings, plan, blockers };
}

export async function previewResumeWorkflow(options: { cwd: string; sourceBatchId: string; configPath?: string; concurrency?: number; allowDirtyBase?: boolean }): Promise<ResumeWorkflowPreview> {
  const source = await sourceBatch(options.cwd, options.sourceBatchId);
  const blockers: WorkflowPlanBlocker[] = [];
  if (["succeeded", "succeeded_with_warnings"].includes(source.batch.batchStatus)) blockers.push({ code: "BATCH_ALREADY_SUCCEEDED", category: "task_selection", message: `Batch ${source.batch.batchId} already succeeded.`, correction: "Use rerun to create a new evaluation." });
  if (!source.batch.plan || !source.batch.configFingerprint) blockers.push({ code: "BATCH_PLAN_MISSING", category: "persistence", message: `Batch ${source.batch.batchId} has no resumable workflow plan.`, correction: "Rerun the workflow from current configuration." });
  if (!source.batch.plan || !source.batch.configFingerprint) return { kind: "resume", sourceBatchId: source.batch.batchId, compatible: false, reusableTaskIds: [], requeuedTaskIds: [], blockers, warnings: source.warnings };
  const preview = await createWorkflowPlanPreview({
    cwd: options.cwd, configPath: options.configPath ?? source.batch.configPath, taskIds: source.batch.plan.selectedRoots,
    concurrency: options.concurrency ?? source.batch.plan.concurrency, failureMode: source.batch.plan.failureMode,
    isolation: source.batch.plan.isolation, allowDirtyBase: options.allowDirtyBase ?? source.batch.plan.dirtyBaseAcknowledged
  });
  blockers.push(...preview.blockers);
  if (preview.plan.configFingerprint !== source.batch.configFingerprint) blockers.push({ code: "RESUME_CONFIG_CHANGED", category: "configuration", message: "The current workflow configuration is incompatible with the source batch.", correction: "Restore the original semantics or use rerun." });
  if ((preview.sourceHead ?? undefined) !== (source.batch.sourceHead ?? undefined)) blockers.push({ code: "RESUME_HEAD_CHANGED", category: "repository_validation", message: "Git HEAD changed since the source batch was created.", correction: "Restore the original HEAD or use rerun." });
  const reusableTaskIds: string[] = [];
  const requeuedTaskIds: string[] = [];
  for (const task of source.batch.tasks) {
    const final = task.finalAttempt === undefined ? undefined : task.attempts.find((attempt) => attempt.attempt === task.finalAttempt);
    const missing = final ? !fs.existsSync(path.resolve(preview.projectRoot, final.manifest)) : false;
    const missingResult = source.batch.plan.isolation === "worktree" && task.state === "succeeded" && Boolean(final?.resultRevision)
      && !await resultRefExists(preview.projectRoot, final!.resultRevision!, final!.runId);
    const reusable = task.state === "succeeded" && !missing && !missingResult;
    const retryable = task.state === "failed" && final?.retryEligible === true;
    const requeue = missing || missingResult || retryable || ["interrupted", "incomplete", "blocked", "skipped", "pending", "ready", "running", "retry_wait"].includes(task.state);
    if (reusable) reusableTaskIds.push(task.id);
    if (requeue) requeuedTaskIds.push(task.id);
  }
  if (requeuedTaskIds.length === 0) blockers.push({ code: "BATCH_NOT_RESUMABLE", category: "task_selection", message: `Batch ${source.batch.batchId} has no tasks eligible for continuation.`, correction: "Use rerun to create a new evaluation." });
  return {
    kind: "resume", sourceBatchId: source.batch.batchId, compatible: blockers.length === 0,
    reusableTaskIds, requeuedTaskIds, plan: preview, blockers, warnings: [...source.warnings, ...preview.warnings]
  };
}

function failedBranchRoots(batch: BatchRecord): string[] {
  const blocked = new Set(batch.tasks.filter((task) => task.state === "blocked").map((task) => task.id));
  if (blocked.size === 0) return batch.tasks.filter((task) => task.state === "failed").map((task) => task.id);
  const outgoing = new Set((batch.plan?.edges ?? []).filter((edge) => blocked.has(edge.from) && blocked.has(edge.to)).map((edge) => edge.from));
  return [...blocked].filter((id) => !outgoing.has(id));
}

export async function previewRerunWorkflow(options: { cwd: string; sourceBatchId: string; mode: "failed" | "failed-branch" | "all"; configPath?: string } & WorkflowExecutionOverrides): Promise<RerunWorkflowPreview> {
  const source = await sourceBatch(options.cwd, options.sourceBatchId);
  if (!source.batch.plan) throw new AriadneError({ category: "persistence", code: "BATCH_PLAN_MISSING", stage: "validated", message: `Batch ${source.batch.batchId} has no rerunnable workflow plan.`, correction: "Run a new workflow from current configuration." });
  const selectedSourceTaskIds = options.mode === "all"
    ? source.batch.plan.selectedRoots
    : options.mode === "failed"
      ? source.batch.tasks.filter((task) => task.state === "failed").map((task) => task.id)
      : failedBranchRoots(source.batch);
  if (selectedSourceTaskIds.length === 0) throw new AriadneError({ category: "task_selection", code: "RERUN_SELECTION_EMPTY", stage: "validated", message: `Rerun mode ${options.mode} selected no tasks from batch ${source.batch.batchId}.`, correction: "Choose a rerun mode that matches the source batch state." });
  const plan = await createWorkflowPlanPreview({
    cwd: options.cwd, configPath: options.configPath ?? source.batch.configPath, taskIds: selectedSourceTaskIds,
    concurrency: options.concurrency, failureMode: options.failureMode, isolation: options.isolation, allowDirtyBase: options.allowDirtyBase
  });
  return { kind: "rerun", mode: options.mode, sourceBatchId: source.batch.batchId, selectedSourceTaskIds, plan, warnings: [...source.warnings, ...plan.warnings] };
}

function throwBlocker(blocker: WorkflowPlanBlocker): never {
  throw new AriadneError({ category: blocker.category, code: blocker.code, stage: "validated", message: blocker.message, correction: blocker.correction });
}

export async function startWorkflowExecution(request: WorkflowLaunchRequest): Promise<WorkflowExecutionHandle> {
  const startedAt = new Date();
  const executionBatchId = createBatchId(startedAt);
  const channel = new WorkflowRuntimeChannel(executionBatchId);
  const controller = new AbortController();
  const relayAbort = () => controller.abort(request.signal?.reason);
  request.signal?.addEventListener("abort", relayAbort, { once: true });
  if (request.signal?.aborted) relayAbort();

  let operation: Promise<BatchRecord & { outputPath: string }>;
  if (request.kind === "run") {
    operation = runWorkflow({ ...request, batchId: executionBatchId, startedAt, signal: controller.signal, runtime: channel });
  } else if (request.kind === "resume") {
    const preview = await previewResumeWorkflow(request);
    if (!preview.compatible) throwBlocker(preview.blockers[0]!);
    operation = resumeWorkflow({
      cwd: request.cwd, batchId: request.sourceBatchId, configPath: request.configPath,
      concurrency: request.concurrency, allowDirtyBase: request.allowDirtyBase, signal: controller.signal,
      onProgress: request.onProgress, executionBatchId, startedAt, runtime: channel
    });
  } else {
    const selectedSourceTaskIds = request.mode === "failed-branch"
      ? (await previewRerunWorkflow({ ...request, mode: "failed-branch" })).selectedSourceTaskIds
      : request.taskIds;
    operation = rerunWorkflow({
      cwd: request.cwd, batchId: request.sourceBatchId, configPath: request.configPath,
      mode: request.mode === "failed-branch" ? "tasks" : request.mode,
      taskIds: selectedSourceTaskIds,
      concurrency: request.concurrency, failureMode: request.failureMode, isolation: request.isolation,
      allowDirtyBase: request.allowDirtyBase, signal: controller.signal, onProgress: request.onProgress,
      executionBatchId, startedAt, runtime: channel
    });
  }

  const completion = operation.finally(() => request.signal?.removeEventListener("abort", relayAbort));
  let cancellation: Promise<BatchRecord & { outputPath: string }> | undefined;
  return {
    batchId: executionBatchId,
    startedAt: startedAt.toISOString(),
    completion,
    subscribe: (listener) => channel.subscribe(listener),
    latestSnapshot: () => channel.latestSnapshot(),
    requestCancellation(reason = "Workflow cancellation requested.") {
      if (!cancellation) {
        channel.emitCancellationHints();
        controller.abort(reason);
        cancellation = completion;
      }
      return cancellation;
    }
  };
}

export class ActiveWorkflowRegistry {
  private handle?: WorkflowExecutionHandle;
  private readonly listeners = new Set<() => void>();

  current(): WorkflowExecutionHandle | undefined {
    return this.handle;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(request: WorkflowLaunchRequest): Promise<WorkflowExecutionHandle> {
    if (this.handle && this.handle.latestSnapshot().state !== "completed") throw new AriadneError({
      category: "task_selection", code: "TUI_WORKFLOW_ACTIVE", stage: "validated",
      message: `Workflow ${this.handle.batchId} is already active in this TUI process.`,
      correction: "Wait for it to finish or cancel it before launching another workflow."
    });
    const handle = await startWorkflowExecution(request);
    this.handle = handle;
    this.notify();
    void handle.completion.then(() => this.notify(), () => this.notify());
    return handle;
  }

  async cancel(reason?: string): Promise<BatchRecord & { outputPath: string }> {
    if (!this.handle) throw new AriadneError({ category: "task_selection", code: "TUI_WORKFLOW_NOT_ACTIVE", stage: "validated", message: "No workflow is active in this TUI process.", correction: "Choose an attached active workflow." });
    return this.handle.requestCancellation(reason);
  }

  async waitForIdle(): Promise<void> {
    if (this.handle) await this.handle.completion.then(() => undefined, () => undefined);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
