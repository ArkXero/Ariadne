import path from "node:path";
import fs from "fs-extra";
import { atomicWriteFile, atomicWriteJson } from "./atomic.js";
import { createBatchId, createBatchPaths, initialBatchRecord, persistBatch, updateBatchPointers } from "./batch-persistence.js";
import { loadConfig, MAX_CONCURRENCY } from "./config.js";
import { AriadneError, asAriadneError, safeValue } from "./errors.js";
import { captureRepositorySnapshot } from "./git.js";
import { buildHtmlReport, buildReportModel } from "./report.js";
import { executeTaskAttempt } from "./runner.js";
import { summarizeOutcome } from "./persistence.js";
import { loadTasks } from "./task-loader.js";
import { getAriadneVersion } from "./version.js";
import { WorkflowGraph } from "./workflow-graph.js";
import { buildWorkflowPlan } from "./workflow-planner.js";
import { buildBatchHtmlReport, buildBatchReportModel } from "./workflow-report.js";
import { repositoryIdentity } from "./workspace-manager.js";
import type { WorkflowRuntimeEmitter } from "./workflow-runtime.js";
import type {
  AriadneConfig, AriadneTask, BatchAttemptReference, BatchPaths, BatchRecord, BatchStatus, BatchTaskRecord,
  BatchTaskState, FailureMode, FailureRecord, RunRecord, TaskOutcome, WorkflowPlan
} from "../types/index.js";

export interface PreparedWorkflow {
  projectRoot: string;
  configPath: string;
  config: AriadneConfig;
  tasks: AriadneTask[];
  graph: WorkflowGraph;
  plan: WorkflowPlan;
  sourceHead?: string;
  repositoryId?: string;
  sourceDirty: boolean;
  excludedSourceChanges: Awaited<ReturnType<typeof captureRepositorySnapshot>>["entries"];
  compatibilityWarnings: string[];
}

export interface WorkflowOptions {
  cwd: string;
  configPath?: string;
  taskIds?: string[];
  concurrency?: number;
  failureMode?: FailureMode;
  isolation?: AriadneConfig["execution"]["isolation"];
  allowDirtyBase?: boolean;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  now?: () => Date;
  randomId?: () => string;
  relation?: BatchRecord["relation"];
  seedTasks?: BatchTaskRecord[];
  initialWarnings?: string[];
  resumeCompatibility?: { configFingerprint: string; sourceHead?: string };
  batchId?: string;
  startedAt?: Date;
  prepared?: PreparedWorkflow;
  runtime?: WorkflowRuntimeEmitter;
}

function relative(root: string, value: string): string {
  return path.relative(root, value).split(path.sep).join("/");
}

function failure(error: AriadneError, projectRoot?: string): FailureRecord {
  const source = error.source && projectRoot && path.isAbsolute(error.source)
    ? (() => { const value = path.relative(projectRoot, error.source!); return value === "" || (!value.startsWith("..") && !path.isAbsolute(value)) ? value || "." : "[outside project root]"; })()
    : error.source;
  const diagnostic = {
    ...(error.fieldPath ? { fieldPath: error.fieldPath } : {}),
    ...(error.offendingValue !== undefined ? { offendingValue: safeValue(error.offendingValue) } : {}),
    ...(error.expected ? { expected: error.expected } : {}),
    ...(error.correction ? { correction: error.correction } : {})
  };
  return {
    category: error.category, code: error.code, stage: error.stage, message: error.message,
    ...(source ? { source } : {}),
    ...(Object.keys(diagnostic).length > 0 || error.details ? { details: { ...error.details, ...(Object.keys(diagnostic).length > 0 ? { diagnostic } : {}) } } : {})
  };
}

function validateConcurrency(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_CONCURRENCY) {
    throw new AriadneError({
      category: "configuration", code: "WORKFLOW_CONCURRENCY_INVALID", stage: "validated", fieldPath: "concurrency", offendingValue: value,
      expected: `An integer from 1 through ${MAX_CONCURRENCY}.`, message: `Workflow concurrency must be between 1 and ${MAX_CONCURRENCY}.`,
      correction: `Choose --concurrency 1..${MAX_CONCURRENCY}.`
    });
  }
}

export async function prepareWorkflow(options: Pick<WorkflowOptions, "cwd" | "configPath" | "taskIds" | "concurrency" | "failureMode" | "isolation" | "allowDirtyBase"> & { createdAt?: Date }): Promise<PreparedWorkflow> {
  const loaded = await loadConfig(options.cwd, options.configPath);
  const tasks = await loadTasks(loaded.projectRoot, loaded.config.tasks.directory, loaded.config.sourceVersion);
  const graph = new WorkflowGraph(tasks);
  const concurrency = options.concurrency ?? loaded.config.execution.concurrency;
  validateConcurrency(concurrency);
  const plan = buildWorkflowPlan({ graph, config: loaded.config, selectedIds: options.taskIds, concurrency, failureMode: options.failureMode, isolation: options.isolation, dirtyBaseAcknowledged: options.allowDirtyBase, createdAt: options.createdAt });
  const repository = await captureRepositorySnapshot(loaded.projectRoot, [".ariadne"]);
  const dirtyEntries = repository.entries.filter((entry) => entry.changeType !== "ignored");
  if (!repository.available && (loaded.config.checks.max_changed_files !== undefined || loaded.config.checks.max_diff_lines !== undefined)) {
    throw new AriadneError({
      category: "repository_validation", code: "GIT_REQUIRED_FOR_POLICIES", stage: "validated",
      message: "Git repository state is unavailable, but changed-file or diff-line policies are configured.",
      correction: "Run inside a Git repository or remove Git-dependent limits.", details: { reason: repository.unavailableReason }
    });
  }
  let repositoryId: string | undefined;
  if (plan.isolation === "worktree") {
    if (!repository.available || !repository.head) {
      throw new AriadneError({
        category: "workspace_management", code: "WORKTREE_SOURCE_REQUIRED", stage: "validated",
        message: "Worktree isolation requires a Git repository with a committed HEAD.", correction: "Commit the source revision or choose --isolation shared."
      });
    }
    if (repository.dirty && !plan.dirtyBaseAcknowledged) {
      throw new AriadneError({
        category: "repository_validation", code: "DIRTY_WORKTREE_BASE", stage: "validated",
        message: "The primary checkout is dirty; worktree isolation uses committed HEAD only.",
        fieldPath: "repository",
        offendingValue: dirtyEntries.map((entry) => entry.path),
        expected: "A clean primary checkout containing no tracked, staged, unstaged, or untracked changes.",
        correction: "Commit or clean the checkout, or pass --allow-dirty-base to explicitly exclude current dirt.",
        details: { excludedPaths: dirtyEntries.map((entry) => entry.path) }
      });
    }
    repositoryId = (await repositoryIdentity(loaded.projectRoot)).repositoryId;
  }
  const compatibilityWarnings = [...loaded.warnings];
  if (plan.isolation === "worktree" && repository.dirty && plan.dirtyBaseAcknowledged) {
    compatibilityWarnings.push("Dirty primary checkout acknowledged: isolated worktrees use committed HEAD and exclude all current primary changes.");
  }
  return {
    projectRoot: loaded.projectRoot,
    configPath: relative(loaded.projectRoot, loaded.path),
    config: loaded.config,
    tasks,
    graph,
    plan,
    sourceHead: repository.head,
    repositoryId,
    sourceDirty: repository.dirty,
    excludedSourceChanges: dirtyEntries,
    compatibilityWarnings
  };
}

export async function planWorkflow(options: Pick<WorkflowOptions, "cwd" | "configPath" | "taskIds" | "concurrency" | "failureMode" | "isolation" | "allowDirtyBase">): Promise<WorkflowPlan> {
  return (await prepareWorkflow(options)).plan;
}

function makeBatchTasks(prepared: PreparedWorkflow, seeds?: BatchTaskRecord[]): BatchTaskRecord[] {
  const seed = new Map((seeds ?? []).map((task) => [task.id.toLowerCase(), task]));
  return prepared.plan.tasks.map((planned) => {
    const existing = seed.get(planned.id.toLowerCase());
    return {
      id: planned.id,
      name: planned.name,
      file: planned.file,
      dependencies: [...planned.dependencies],
      workspaceMode: planned.workspaceMode,
      retry: { ...planned.retry },
      state: existing?.state ?? "pending",
      ...(existing?.finalOutcome ? { finalOutcome: existing.finalOutcome } : {}),
      attempts: existing ? existing.attempts.map((attempt) => ({ ...attempt })) : [],
      ...(existing?.finalAttempt ? { finalAttempt: existing.finalAttempt } : {}),
      ...(existing?.blockReason ? { blockReason: { ...existing.blockReason, chain: [...existing.blockReason.chain] } } : {}),
      ...(existing?.skipReason ? { skipReason: existing.skipReason } : {}),
      warnings: existing ? [...existing.warnings] : []
    };
  });
}

function terminal(state: BatchTaskState): boolean {
  return ["succeeded", "failed", "blocked", "skipped", "interrupted", "incomplete"].includes(state);
}

function retryDecision(run: RunRecord): { eligible: boolean; reason?: string } {
  const result = run.results[0];
  if (!result) return { eligible: false };
  if (result.policies.some((policy) => policy.outcome === "fail") || result.failures.some((item) => item.category === "policy_violation")) return { eligible: false };
  if (result.outcome === "agent_failed" && !result.agent?.spawnError) return { eligible: true, reason: "Agent exited nonzero." };
  if (result.outcome === "verification_failed" && !result.failures.some((item) => item.category === "verification_spawn")) return { eligible: true, reason: "Verification failed." };
  if (result.outcome === "timeout") {
    const timed = [result.agent, ...result.verification.map((verification) => verification.command)].filter((process) => process?.timedOut);
    const cleaned = timed.every((process) => !process?.cleanup.attempted || (process.cleanup.forceSignal ? process.cleanup.forceSucceeded === true : process.cleanup.gracefulSucceeded === true));
    return cleaned ? { eligible: true, reason: "Timed-out process cleanup was confirmed." } : { eligible: false };
  }
  return { eligible: false };
}

function retryDelay(task: BatchTaskRecord, attemptInInvocation: number): number {
  if (task.retry.backoff === "fixed") return task.retry.delayMs;
  return Math.min(3_600_000, task.retry.delayMs * 2 ** Math.max(0, attemptInInvocation - 1));
}

function stateForOutcome(outcome: TaskOutcome): BatchTaskState {
  return outcome === "passed" ? "succeeded" : outcome === "interrupted" ? "interrupted" : outcome === "internal_failed" ? "incomplete" : "failed";
}

function refreshRunningSummary(record: BatchRecord): void {
  if (record.status !== "running") return;
  const count = (state: BatchTaskState) => record.tasks.filter((task) => task.state === state).length;
  const finalAttempts = record.tasks.flatMap((task) => task.finalAttempt === undefined ? [] : task.attempts.filter((attempt) => attempt.attempt === task.finalAttempt));
  const outcomes = record.tasks.flatMap((task) => task.finalOutcome ? [task.finalOutcome] : task.blockReason?.outcome ? [task.blockReason.outcome] : []);
  const failureOutcomes: TaskOutcome[] = record.failures.some((item) => item.category === "internal" || item.category === "persistence")
    ? ["internal_failed"] : record.failures.some((item) => item.category === "policy_violation") ? ["policy_failed"] : [];
  const currentOutcome = summarizeOutcome([...outcomes, ...failureOutcomes].length > 0 ? [...outcomes, ...failureOutcomes] : ["passed"]);
  const scores = finalAttempts.map((attempt) => attempt.score);
  record.batchStatus = "running";
  record.outcome = currentOutcome;
  record.summary = {
    total: record.tasks.length,
    succeeded: count("succeeded"),
    failed: count("failed"),
    blocked: count("blocked"),
    skipped: count("skipped"),
    interrupted: count("interrupted"),
    incomplete: count("incomplete"),
    retried: record.tasks.filter((task) => task.attempts.length > 1).length,
    score: scores.length === 0 ? null : scores.reduce((sum, score) => sum + score, 0) / scores.length,
    status: "running",
    outcome: currentOutcome
  };
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<"ready" | "aborted"> {
  if (signal?.aborted) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve("ready"); }, ms);
    const abort = () => { clearTimeout(timer); resolve("aborted"); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function writeChildReport(projectRoot: string, run: RunRecord & { outputPath: string }): Promise<string> {
  const reportPath = path.join(path.dirname(run.outputPath), "report.html");
  const relativeReport = relative(projectRoot, reportPath);
  await atomicWriteFile(reportPath, buildHtmlReport(buildReportModel(run, [], run.outputPath)));
  run.artifacts.report = relativeReport;
  const { outputPath, ...persisted } = run;
  await atomicWriteJson(outputPath, persisted);
  return relativeReport;
}

function summarizeBatch(record: BatchRecord): void {
  const counts = (state: BatchTaskState) => record.tasks.filter((task) => task.state === state).length;
  const finalAttempts = record.tasks.flatMap((task) => task.finalAttempt === undefined ? [] : task.attempts.filter((attempt) => attempt.attempt === task.finalAttempt));
  const outcomes = record.tasks.flatMap((task) => task.finalOutcome ? [task.finalOutcome] : task.blockReason?.outcome ? [task.blockReason.outcome] : []);
  const failureOutcome: TaskOutcome[] = record.failures.some((item) => item.category === "internal" || item.category === "persistence")
    ? ["internal_failed"]
    : record.failures.some((item) => item.category === "policy_violation") ? ["policy_failed"] : [];
  const outcome = summarizeOutcome([...outcomes, ...failureOutcome].length > 0 ? [...outcomes, ...failureOutcome] : record.failures.length > 0 ? ["internal_failed"] : ["passed"]);
  const succeeded = counts("succeeded");
  const unsuccessful = record.tasks.length - succeeded;
  let batchStatus: BatchStatus;
  if (record.tasks.some((task) => task.state === "interrupted") || outcome === "interrupted") batchStatus = "interrupted";
  else if (record.tasks.some((task) => task.state === "incomplete") || record.failures.some((item) => item.category === "internal" || item.category === "persistence")) batchStatus = "incomplete";
  else if (record.failures.length > 0 && record.tasks.length === 0) batchStatus = "failed";
  else if (unsuccessful === 0) batchStatus = record.tasks.some((task) => task.attempts.length > 1 || task.warnings.length > 0) || record.warnings.length > 0 ? "succeeded_with_warnings" : "succeeded";
  else batchStatus = succeeded > 0 ? "partially_failed" : "failed";
  const scores = finalAttempts.map((attempt) => attempt.score);
  record.status = batchStatus === "succeeded" || batchStatus === "succeeded_with_warnings" ? "completed"
    : batchStatus === "interrupted" ? "interrupted" : batchStatus === "incomplete" ? "incomplete" : "failed";
  record.batchStatus = batchStatus;
  record.outcome = outcome;
  record.summary = {
    total: record.tasks.length, succeeded, failed: counts("failed"), blocked: counts("blocked"), skipped: counts("skipped"),
    interrupted: counts("interrupted"), incomplete: counts("incomplete"),
    retried: record.tasks.filter((task) => task.attempts.length > 1).length,
    score: scores.length === 0 ? null : scores.reduce((sum, score) => sum + score, 0) / scores.length,
    status: batchStatus, outcome
  };
}

async function checkpoint(record: BatchRecord, paths: BatchPaths, stage?: BatchRecord["lifecycle"][number]["stage"], detail?: string, taskId?: string): Promise<void> {
  if (stage) record.lifecycle.push({ stage, at: new Date().toISOString(), ...(detail ? { detail } : {}), ...(taskId ? { taskId } : {}) });
  refreshRunningSummary(record);
  await persistBatch(record, paths);
}

async function executeSchedule(prepared: PreparedWorkflow, record: BatchRecord, paths: BatchPaths, options: WorkflowOptions): Promise<void> {
  type AttemptCompletion = { id: string; run?: RunRecord & { outputPath: string }; error?: unknown };
  type DelayCompletion = { id: string; delay: "ready" | "aborted" };
  type ScheduleCompletion = AttemptCompletion | DelayCompletion;
  const byId = new Map(record.tasks.map((task) => [task.id, task]));
  const planIndex = new Map(prepared.plan.order.map((id, index) => [id, index]));
  const attemptsThisInvocation = new Map(record.tasks.map((task) => [task.id, 0]));
  const active = new Map<string, Promise<AttemptCompletion>>();
  const delays = new Map<string, Promise<DelayCompletion>>();
  const settled: ScheduleCompletion[] = [];
  const delayControllers = new Map<string, AbortController>();
  const overlaps = new Map(record.tasks.map((task) => [task.id, new Set<string>()]));
  const parallelViolations = new Set<string>();
  const provisionalSuccess = new Set<string>();
  let stopLaunching = false;
  let cancellationRecorded = false;
  let primaryGuardViolated = false;
  const emittedTerminalStates = new Map<string, BatchTaskState>();
  const emittedWarnings = new Set<string>();
  const primarySignature = JSON.stringify({ head: prepared.sourceHead, entries: prepared.excludedSourceChanges });

  const guardPrimary = async (): Promise<boolean> => {
    if (prepared.plan.isolation !== "worktree" || primaryGuardViolated) return !primaryGuardViolated;
    const current = await captureRepositorySnapshot(prepared.projectRoot, [".ariadne"]);
    const currentDirtyEntries = current.entries.filter((entry) => entry.changeType !== "ignored");
    if (JSON.stringify({ head: current.head, entries: currentDirtyEntries }) === primarySignature) return true;
    primaryGuardViolated = true;
    stopLaunching = true;
    record.failures.push({
      category: "workspace_management", code: "PRIMARY_CHECKOUT_MUTATED", stage: "workspace_ready",
      message: "The primary checkout changed during isolated execution; new launches stopped and active results are treated as uncertain.",
      details: { baseline: prepared.excludedSourceChanges.map((entry) => entry.path), current: currentDirtyEntries.map((entry) => entry.path) }
    });
    for (const id of active.keys()) byId.get(id)?.warnings.push("Primary checkout mutation was detected while this isolated task was active.");
    await persistState("Primary checkout guard detected Git-visible mutation.");
    return false;
  };

  const persistState = async (detail = "Scheduler state checkpoint.", taskId?: string) => {
    await checkpoint(record, paths, "running", detail, taskId);
    for (const warning of record.warnings) {
      const key = `batch\0${warning}`;
      if (emittedWarnings.has(key)) continue;
      emittedWarnings.add(key);
      options.runtime?.emit({ type: "runtime.warning", category: "batch", message: warning });
    }
    for (const task of record.tasks) {
      for (const warning of task.warnings) {
        const key = `${task.id}\0${warning}`;
        if (emittedWarnings.has(key)) continue;
        emittedWarnings.add(key);
        options.runtime?.emit({ type: "runtime.warning", category: "task", taskId: task.id, message: warning });
      }
      if (!terminal(task.state) || emittedTerminalStates.get(task.id) === task.state) continue;
      const final = task.finalAttempt === undefined ? task.attempts.at(-1) : task.attempts.find((attempt) => attempt.attempt === task.finalAttempt);
      options.runtime?.emit({
        type: "task.completed", taskId: task.id, attempt: final?.attempt ?? 0,
        ...(final?.runId ? { runId: final.runId } : {}), state: task.state,
        ...(task.finalOutcome ? { outcome: task.finalOutcome } : {})
      });
      emittedTerminalStates.set(task.id, task.state);
    }
    options.runtime?.emit({ type: "batch.state", status: record.batchStatus, summary: { ...record.summary } });
  };
  const dependencies = (task: BatchTaskRecord) => task.dependencies.map((id) => byId.get(id)!);

  const propagate = (): boolean => {
    let changed = false;
    for (const task of record.tasks.sort((a, b) => (planIndex.get(a.id) ?? 0) - (planIndex.get(b.id) ?? 0))) {
      if (terminal(task.state) || task.state === "running" || task.state === "retry_wait") continue;
      const failed = dependencies(task).find((dependency) => terminal(dependency.state) && dependency.state !== "succeeded");
      if (failed) {
        const final = failed.finalAttempt === undefined ? undefined : failed.attempts.find((attempt) => attempt.attempt === failed.finalAttempt);
        task.state = "blocked";
        task.blockReason = {
          dependencyId: failed.id, dependencyState: failed.state, runId: final?.runId, outcome: final?.outcome ?? failed.blockReason?.outcome,
          chain: [failed.id, ...(failed.blockReason?.chain ?? [])], message: `Dependency ${failed.id} ended as ${failed.state}.`
        };
        record.lifecycle.push({ stage: "running", at: new Date().toISOString(), taskId: task.id, detail: task.blockReason.message });
        options.runtime?.emit({ type: "task.blocked", taskId: task.id, blockedBy: task.blockReason.chain, reason: task.blockReason.message });
        changed = true;
      } else if (dependencies(task).every((dependency) => dependency.state === "succeeded") && task.state === "pending") {
        task.state = "ready";
        record.lifecycle.push({ stage: "running", at: new Date().toISOString(), taskId: task.id, detail: "Task became ready." });
        options.runtime?.emit({ type: "task.ready", taskId: task.id });
        changed = true;
      }
    }
    return changed;
  };

  const launch = (task: BatchTaskRecord): void => {
    task.state = "running";
    const activeSafe = [...active.keys()].filter((id) => prepared.plan.isolation === "worktree" || byId.get(id)?.workspaceMode === "read-only");
    for (const id of activeSafe) { overlaps.get(task.id)!.add(id); overlaps.get(id)!.add(task.id); }
    const attemptInInvocation = (attemptsThisInvocation.get(task.id) ?? 0) + 1;
    attemptsThisInvocation.set(task.id, attemptInInvocation);
    const attempt = (task.attempts.at(-1)?.attempt ?? 0) + 1;
    record.lifecycle.push({ stage: "running", at: new Date().toISOString(), taskId: task.id, detail: `Attempt ${attempt} started.` });
    options.onProgress?.(`Running task: ${task.id} (attempt ${attempt})`);
    options.runtime?.emit({ type: "task.started", taskId: task.id, attempt });
    const promise = executeTaskAttempt({
      projectRoot: prepared.projectRoot, config: prepared.config, configPath: prepared.configPath,
      task: prepared.graph.require(task.id), batchId: record.batchId, planId: prepared.plan.planId, attempt,
      isolation: prepared.plan.isolation,
      retention: prepared.plan.retention,
      allowDirtyBase: prepared.plan.dirtyBaseAcknowledged,
      sourceRevision: prepared.sourceHead,
      repositoryId: prepared.repositoryId,
      excludedSourceChanges: prepared.excludedSourceChanges,
      inheritedResults: dependencies(task).map((dependency) => {
        const final = dependency.finalAttempt === undefined ? undefined : dependency.attempts.find((item) => item.attempt === dependency.finalAttempt);
        return final?.resultRevision ? { taskId: dependency.id, runId: final.runId, resultRevision: final.resultRevision } : undefined;
      }).filter((item): item is { taskId: string; runId: string; resultRevision: string } => item !== undefined),
      signal: options.signal,
      runtime: options.runtime
    }).then((run): AttemptCompletion => ({ id: task.id, run }), (error): AttemptCompletion => ({ id: task.id, error }))
      .then((completion) => { settled.push(completion); return completion; });
    active.set(task.id, promise);
  };

  await checkpoint(record, paths, "running", `Executing ${record.tasks.length} task(s).`);
  try {
    while (record.tasks.some((task) => !terminal(task.state))) {
    for (const id of [...provisionalSuccess]) {
      if ([...overlaps.get(id)!].some((peer) => active.has(peer))) continue;
      const task = byId.get(id)!;
      task.state = parallelViolations.has(id) ? "failed" : "succeeded";
      task.finalOutcome = parallelViolations.has(id) ? "policy_failed" : "passed";
      provisionalSuccess.delete(id);
    }
    if (options.signal?.aborted) {
      stopLaunching = true;
      if (!cancellationRecorded) {
        cancellationRecorded = true;
        options.runtime?.emit({ type: "batch.cancellation_requested" });
        options.runtime?.emit({ type: "batch.cancellation_progress", stage: "launches-stopped" });
        await checkpoint(record, paths, "cancelling", "Workflow interruption requested; stopping launches and retry waits.");
      }
    }
    if (stopLaunching) {
      for (const controller of delayControllers.values()) controller.abort();
      if (options.signal?.aborted && active.size > 0) options.runtime?.emit({ type: "batch.cancellation_progress", stage: "processes-terminating", detail: `${active.size} active task process${active.size === 1 ? "" : "es"}` });
    }
    if (propagate()) await persistState();

    if (stopLaunching && active.size === 0 && delays.size === 0) {
      for (const task of record.tasks) {
        if (task.state === "retry_wait") { task.state = "interrupted"; task.finalOutcome = "interrupted"; }
        else if (!terminal(task.state)) { task.state = "skipped"; task.skipReason = options.signal?.aborted ? "Workflow was interrupted before launch." : "Failure mode stopped new task launches."; }
      }
      await persistState(options.signal?.aborted ? "Interrupted pending scheduler work." : "Stopped pending scheduler work after failure.");
      if (options.signal?.aborted) options.runtime?.emit({ type: "batch.cancellation_progress", stage: "tasks-finalizing" });
      break;
    }

    if (!stopLaunching && settled.length === 0) {
      await guardPrimary();
      const ready = record.tasks.filter((task) => task.state === "ready").sort((a, b) => (planIndex.get(a.id) ?? 0) - (planIndex.get(b.id) ?? 0));
      const activeHasExclusive = prepared.plan.isolation === "shared" && [...active.keys()].some((id) => byId.get(id)!.workspaceMode === "mutable");
      if (!activeHasExclusive && active.size < prepared.plan.concurrency && ready.length > 0) {
        if (active.size === 0 && prepared.plan.isolation === "shared" && ready[0].workspaceMode === "mutable") launch(ready[0]);
        else {
          for (const task of ready) {
            if ((prepared.plan.isolation === "shared" && task.workspaceMode === "mutable") || active.size >= prepared.plan.concurrency) break;
            launch(task);
          }
        }
        await persistState();
      }
    }

    if (active.size === 0 && delays.size === 0 && settled.length === 0) {
      if (!record.tasks.some((task) => !terminal(task.state))) break;
      continue;
    }

    if (settled.length === 0) {
      await Promise.race([...active.values(), ...delays.values()]);
      await Promise.resolve();
    }
    settled.sort((left, right) => (planIndex.get(left.id) ?? 0) - (planIndex.get(right.id) ?? 0));
    const completion = settled.shift();
    if (!completion) continue;
    if (options.signal?.aborted && !cancellationRecorded) {
      cancellationRecorded = true;
      options.runtime?.emit({ type: "batch.cancellation_requested" });
      options.runtime?.emit({ type: "batch.cancellation_progress", stage: "launches-stopped" });
      await checkpoint(record, paths, "cancelling", "Workflow interruption requested; stopping launches and retry waits.");
    }
    if ("delay" in completion) {
      delays.delete(completion.id);
      delayControllers.delete(completion.id);
      const task = byId.get(completion.id)!;
      if (completion.delay === "aborted") {
        task.state = options.signal?.aborted ? "interrupted" : "skipped";
        if (options.signal?.aborted) task.finalOutcome = "interrupted";
        if (!options.signal?.aborted) task.skipReason = "Failure mode stopped the pending retry.";
      } else task.state = "pending";
      if (completion.delay === "aborted" && options.signal?.aborted) options.runtime?.emit({ type: "batch.cancellation_progress", stage: "retry-delays-cancelled", detail: task.id });
      await persistState(completion.delay === "aborted" ? "Retry wait was cancelled." : "Retry delay completed.", task.id);
      continue;
    }

    active.delete(completion.id);
    await guardPrimary();
    const task = byId.get(completion.id)!;
    if (completion.error || !completion.run) {
      task.state = options.signal?.aborted ? "interrupted" : "incomplete";
      task.finalOutcome = options.signal?.aborted ? "interrupted" : "internal_failed";
      record.failures.push(failure(asAriadneError(completion.error, { category: "internal", code: "ATTEMPT_EXECUTION_FAILED", stage: "preparing" }), prepared.projectRoot));
      stopLaunching = true;
      await persistState();
      continue;
    }

    const run = completion.run;
    const result = run.results[0];
    const childReport = await writeChildReport(prepared.projectRoot, run);
    if (!result) {
      task.state = "incomplete";
      task.finalOutcome = "internal_failed";
      record.failures.push({ category: "internal", code: "ATTEMPT_RESULT_MISSING", stage: "completed", message: `Attempt ${run.runId} produced no task result.`, taskId: task.id });
      stopLaunching = true;
      await persistState();
      continue;
    }
    const retry = retryDecision(run);
    const attemptRef: BatchAttemptReference = {
      attempt: run.workflow?.attempt ?? task.attempts.length + 1,
      runId: run.runId,
      manifest: relative(prepared.projectRoot, run.outputPath),
      report: childReport,
      status: result.status,
      outcome: result.outcome,
      score: result.score.value,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      durationMs: result.durationMs,
      retryEligible: retry.eligible,
      ...(retry.reason ? { retryReason: retry.reason } : {}),
      ...(run.workspace?.workspaceId ? { workspaceId: run.workspace.workspaceId } : {}),
      ...(run.changeArtifact?.resultRevision ? { resultRevision: run.changeArtifact.resultRevision } : {}),
      ...(run.changeArtifact ? { applicable: run.changeArtifact.applicable } : {})
    };
    task.attempts.push(attemptRef);
    task.finalAttempt = attemptRef.attempt;
    const policyWarnings = result.policies.filter((policy) => policy.outcome === "warning").map((policy) => policy.ruleId);
    if (policyWarnings.length > 0) task.warnings.push(`Attempt ${attemptRef.attempt} produced policy warning${policyWarnings.length === 1 ? "" : "s"}: ${policyWarnings.join(", ")}.`);
    record.lifecycle.push({ stage: "running", at: new Date().toISOString(), taskId: task.id, detail: `Attempt ${attemptRef.attempt} finished with ${attemptRef.outcome}.` });

    const visibleMutation = prepared.plan.isolation === "shared" && task.workspaceMode === "read-only" && overlaps.get(task.id)!.size > 0 && (result.trace?.taskChanges.length ?? 0) > 0;
    if (primaryGuardViolated) {
      task.state = "incomplete";
      task.finalOutcome = "internal_failed";
      attemptRef.retryEligible = false;
    } else if (options.signal?.aborted) {
      task.state = "interrupted";
      task.finalOutcome = "interrupted";
      attemptRef.retryEligible = false;
    } else if (visibleMutation) {
      parallelViolations.add(task.id);
      task.state = "failed";
      task.finalOutcome = summarizeOutcome([result.outcome, "policy_failed"]);
      attemptRef.retryEligible = false;
      task.warnings.push("A task declared read-only produced Git-visible changes while overlapping another shared-mode task; shared-tree attribution is unsafe.");
      for (const peer of overlaps.get(task.id)!) {
        parallelViolations.add(peer);
        const peerTask = byId.get(peer);
        if (peerTask) peerTask.finalOutcome = "policy_failed";
        peerTask?.warnings.push(`Overlapped parallel-safety violation from ${task.id}.`);
        if (peerTask?.state === "succeeded") peerTask.state = "failed";
      }
      record.failures.push({ category: "policy_violation", code: "PARALLEL_SAFETY_VIOLATION", stage: "evaluating_policy", message: `Parallel-safe task ${task.id} produced Git-visible repository changes.`, taskId: task.id });
    } else if (retry.eligible && (attemptsThisInvocation.get(task.id) ?? 0) < task.retry.attempts && !options.signal?.aborted) {
      const delayMs = retryDelay(task, attemptsThisInvocation.get(task.id) ?? 1);
      attemptRef.retryDelayMs = delayMs;
      task.state = "retry_wait";
      task.finalOutcome = undefined;
      task.warnings.push(`Attempt ${attemptRef.attempt} failed and will retry from the current working tree.`);
      options.runtime?.emit({
        type: "task.retry_scheduled", taskId: task.id, currentAttempt: attemptRef.attempt,
        nextAttempt: attemptRef.attempt + 1, retryAt: new Date(Date.now() + delayMs).toISOString(), reason: retry.reason ?? "Retry eligible failure."
      });
      const delayController = new AbortController();
      const onAbort = () => delayController.abort();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      delayControllers.set(task.id, delayController);
      delays.set(task.id, abortableDelay(delayMs, delayController.signal)
        .then((delay) => ({ id: task.id, delay }))
        .then((completion) => { settled.push(completion); return completion; })
        .finally(() => options.signal?.removeEventListener("abort", onAbort)));
    } else if (result.outcome === "passed" && prepared.plan.isolation === "shared" && task.workspaceMode === "read-only" && [...overlaps.get(task.id)!].some((peer) => active.has(peer))) {
      task.state = "running";
      provisionalSuccess.add(task.id);
    } else if (parallelViolations.has(task.id)) {
      task.state = "failed";
      task.finalOutcome = summarizeOutcome([result.outcome, "policy_failed"]);
      attemptRef.retryEligible = false;
    } else {
      task.state = stateForOutcome(result.outcome);
      task.finalOutcome = result.outcome;
    }

    if (task.state === "failed" && prepared.plan.failureMode === "fail-fast") stopLaunching = true;
    if (task.state === "incomplete") stopLaunching = true;
    if (task.state === "interrupted") stopLaunching = true;
    if (options.signal?.aborted && task.state === "interrupted") options.runtime?.emit({ type: "batch.cancellation_progress", stage: "tasks-finalizing", detail: task.id });
    await persistState(task.state === "retry_wait" ? `Retry scheduled after ${attemptRef.retryDelayMs ?? 0}ms.` : `Task transitioned to ${task.state}.`, task.id);
    }
    await persistState("Scheduler reached a terminal state.");
  } catch (error) {
    for (const controller of delayControllers.values()) controller.abort();
    await Promise.allSettled([...active.values(), ...delays.values()]);
    throw error;
  }
}

export async function runWorkflow(options: WorkflowOptions): Promise<BatchRecord & { outputPath: string }> {
  const root = await fs.realpath(options.cwd).catch(() => path.resolve(options.cwd));
  const now = options.now ?? (() => new Date());
  const startedAt = options.startedAt ?? now();
  const batchId = options.batchId ?? createBatchId(startedAt, options.randomId?.());
  const paths = await createBatchPaths(root, batchId);
  const record = initialBatchRecord({ batchId, startedAt, ariadneVersion: await getAriadneVersion(), paths });
  if (options.relation) record.relation = options.relation;
  if (options.initialWarnings) record.warnings.push(...options.initialWarnings);
  await persistBatch(record, paths);
  try {
    await checkpoint(record, paths, "planning", "Loading and validating workflow configuration.");
    const prepared = options.prepared ?? await prepareWorkflow({ ...options, createdAt: startedAt });
    if (options.resumeCompatibility && prepared.plan.configFingerprint !== options.resumeCompatibility.configFingerprint) {
      throw new AriadneError({
        category: "configuration", code: "RESUME_CONFIG_CHANGED", stage: "validated",
        message: "Workflow configuration changed while the resume batch was being prepared.",
        expected: options.resumeCompatibility.configFingerprint, offendingValue: prepared.plan.configFingerprint,
        correction: "Restore the source workflow semantics or use ariadne rerun."
      });
    }
    if (options.resumeCompatibility && prepared.sourceHead !== options.resumeCompatibility.sourceHead) {
      throw new AriadneError({
        category: "repository_validation", code: "RESUME_HEAD_CHANGED", stage: "validated",
        message: "Git HEAD changed while the resume batch was being prepared.",
        expected: options.resumeCompatibility.sourceHead ?? "no Git HEAD", offendingValue: prepared.sourceHead ?? "no Git HEAD",
        correction: "Restore the source HEAD or use ariadne rerun."
      });
    }
    record.project.configPath = prepared.configPath;
    record.project.repository = { head: prepared.sourceHead };
    record.configPath = prepared.configPath;
    record.configFingerprint = prepared.plan.configFingerprint;
    record.sourceHead = prepared.sourceHead;
    record.sourceDirty = prepared.sourceDirty;
    record.dirtyBaseAcknowledged = prepared.plan.dirtyBaseAcknowledged;
    record.excludedSourceChanges = prepared.excludedSourceChanges;
    record.repositoryId = prepared.repositoryId;
    record.plan = prepared.plan;
    record.warnings.push(...prepared.compatibilityWarnings);
    record.tasks = makeBatchTasks(prepared, options.seedTasks);
    refreshRunningSummary(record);
    await persistBatch(record, paths);
    options.runtime?.emit({ type: "batch.started", startedAt: record.startedAt, planId: prepared.plan.planId });
    options.runtime?.emit({ type: "batch.state", status: record.batchStatus, summary: { ...record.summary } });
    await executeSchedule(prepared, record, paths, options);
  } catch (error) {
    const ariadneError = asAriadneError(error, { category: "internal", code: "WORKFLOW_INTERNAL_ERROR", stage: "loading" });
    record.failures.push(failure(ariadneError, root));
    for (const task of record.tasks) {
      if (!terminal(task.state)) task.state = options.signal?.aborted ? "interrupted" : "incomplete";
      if (!terminal(task.state)) continue;
      const final = task.finalAttempt === undefined ? task.attempts.at(-1) : task.attempts.find((attempt) => attempt.attempt === task.finalAttempt);
      options.runtime?.emit({ type: "task.completed", taskId: task.id, attempt: final?.attempt ?? 0, ...(final?.runId ? { runId: final.runId } : {}), state: task.state, ...(task.finalOutcome ? { outcome: task.finalOutcome } : {}) });
    }
  }

  const completed = new Date();
  record.completedAt = completed.toISOString();
  record.durationMs = completed.getTime() - startedAt.getTime();
  summarizeBatch(record);
  record.lifecycle.push({ stage: "persisting", at: new Date().toISOString() }, { stage: "completed", at: new Date().toISOString() });
  if (options.signal?.aborted) options.runtime?.emit({ type: "batch.cancellation_progress", stage: "batch-finalizing" });
  const reportPath = path.join(paths.batchDirectory, "report.html");
  try {
    await persistBatch(record, paths);
    await atomicWriteFile(reportPath, buildBatchHtmlReport(buildBatchReportModel(record, [], paths.manifestPath)));
    record.artifacts.report = relative(root, reportPath);
    await persistBatch(record, paths);
    await updateBatchPointers(record, paths);
  } catch (error) {
    record.status = "incomplete";
    record.batchStatus = "incomplete";
    record.outcome = "internal_failed";
    record.summary = { ...record.summary, status: "incomplete", outcome: "internal_failed" };
    record.failures.push(failure(asAriadneError(error, { category: "persistence", code: "BATCH_FINALIZATION_FAILED", stage: "persisting" }), root));
    record.lifecycle.push({ stage: "persisting", at: new Date().toISOString(), detail: "Batch finalization failed; incomplete state was persisted best-effort." });
    let recoveredManifest = false;
    await persistBatch(record, paths).then(() => { recoveredManifest = true; }, () => undefined);
    await atomicWriteFile(reportPath, buildBatchHtmlReport(buildBatchReportModel(record, [], paths.manifestPath))).catch(() => undefined);
    if (recoveredManifest) await updateBatchPointers(record, paths).catch(() => undefined);
  }
  options.runtime?.emit({ type: "batch.completed", status: record.batchStatus, outcome: record.outcome, manifest: record.artifacts.manifest });
  return { ...record, outputPath: paths.manifestPath };
}
