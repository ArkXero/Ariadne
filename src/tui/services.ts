import path from "node:path";
import fs from "fs-extra";
import { loadBatchFile, loadBatchHistory, resolveBatchFile } from "../core/batch-reader.js";
import { loadConfig } from "../core/config.js";
import { AriadneError } from "../core/errors.js";
import { canonicalizePath, isPathInside } from "../core/path-containment.js";
import { loadPromotions } from "../core/promotion.js";
import { buildReportModel } from "../core/report.js";
import { loadRunFile, loadRunHistory, type RunLoadResult } from "../core/run-reader.js";
import { listWorkspaces, resultRefExists } from "../core/workspace-manager.js";
import { buildBatchReportModel } from "../core/workflow-report.js";
import {
  ActiveWorkflowRegistry,
  createWorkflowPlanPreview,
  inspectWorkflowOptions,
  previewRerunWorkflow,
  previewResumeWorkflow,
  type WorkflowExecutionOverrides,
  type WorkflowLaunchRequest
} from "../core/workflow-application.js";
import type { BatchAttemptReference, PromotionRecord, RunRecord, TaskOutcome } from "../types/index.js";
import { readLogPreview } from "./log-preview.js";
import {
  applyReviewedResult,
  compareAttemptResults,
  discardReviewedResult,
  exportPatch,
  inspectApplyEligibility,
  listReviewResults,
  loadFileDiff,
  loadResultSummary,
  previewApplyResult,
  previewDiscardResult,
  previewPatchExport
} from "../core/change-application.js";
import {
  cleanEligibleWorkspaces,
  cleanWorkspace,
  listManagedWorkspaces,
  loadWorkspaceDetail,
  previewEligibleWorkspaceCleanup,
  previewWorkspaceCleanup
} from "../core/workspace-application.js";
import type {
  AttemptDetail,
  AttemptReference,
  BatchHistoryEntry,
  ResultState,
  TaskHistoryEntry,
  TuiDataService,
  TuiSnapshot,
  TuiWarning,
  WarningCode
} from "./types.js";

const OUTCOMES = new Set<TaskOutcome>(["passed", "preparation_failed", "agent_failed", "verification_failed", "policy_failed", "timeout", "interrupted", "internal_failed"]);

function taskOutcome(value: string): TaskOutcome {
  return OUTCOMES.has(value as TaskOutcome) ? value as TaskOutcome : "internal_failed";
}

function warningCode(message: string): WarningCode {
  const lower = message.toLowerCase();
  if (lower.includes("newer than supported") || lower.includes("future")) return "future-record";
  if (lower.includes("missing child") || lower.includes("child run")) return "missing-child";
  if (lower.includes("missing artifact")) return "missing-artifact";
  if (lower.includes("result ref") || lower.includes("managed result")) return "missing-result-ref";
  if (lower.includes("worktree") && lower.includes("missing")) return "missing-worktree";
  if (lower.includes("outside the project root") || lower.includes("leaves the project root")) return "unsafe-path";
  if (lower.includes("no longer alive") || lower.includes("abandoned") || lower.includes("displayed as stale")) return "abandoned-owner";
  if (lower.includes("corrupt") || lower.includes("malformed") || lower.includes("invalid")) return "corrupt-record";
  return "unreadable";
}

function structuredWarning(message: string, index: number, options: { path?: string; recordId?: string; code?: WarningCode } = {}): TuiWarning {
  return {
    id: `${options.code ?? warningCode(message)}:${options.path ?? options.recordId ?? index}:${index}`,
    code: options.code ?? warningCode(message),
    message,
    ...(options.path ? { path: options.path } : {}),
    ...(options.recordId ? { recordId: options.recordId } : {})
  };
}

function deduplicateWarnings(warnings: TuiWarning[]): TuiWarning[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.code}\0${warning.path ?? ""}\0${warning.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((warning, index) => ({ ...warning, id: `${warning.code}:${index}` }));
}

function promotionsForRun(promotions: PromotionRecord[], runId: string): PromotionRecord[] {
  return promotions.filter((promotion) => promotion.runId === runId || promotion.includedRunIds.includes(runId));
}

function stateFromPromotions(promotions: PromotionRecord[], runId: string, applicable: boolean): ResultState {
  if (!applicable) return "not-applicable";
  const relevant = promotionsForRun(promotions, runId);
  if (relevant.some((promotion) => promotion.kind === "apply" && promotion.status === "succeeded")) return "applied";
  if (relevant.some((promotion) => promotion.kind === "discard" && promotion.status === "discarded")) return "discarded";
  if (relevant.some((promotion) => promotion.status === "conflicted")) return "conflicted";
  return "unapplied";
}

function syntheticAttempt(options: {
  key: string;
  path: string;
  runId: string;
  taskIndex: number;
  status: "running" | "passed" | "failed" | "interrupted" | "incomplete";
  outcome: TaskOutcome;
  score: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  source: "standalone" | "legacy";
}): AttemptReference {
  return {
    key: options.key,
    manifestPath: options.path,
    runId: options.runId,
    taskIndex: options.taskIndex,
    attempt: 1,
    status: options.status,
    outcome: options.outcome,
    score: options.score,
    startedAt: options.startedAt,
    completedAt: options.completedAt,
    durationMs: options.durationMs,
    retryEligible: false,
    final: true,
    source: options.source,
    manifest: options.path
  };
}

function batchAttempt(taskKey: string, reference: BatchAttemptReference, finalAttempt: number | undefined): AttemptReference {
  return {
    ...reference,
    key: `${taskKey}:attempt:${reference.attempt}`,
    manifestPath: reference.manifest,
    final: reference.attempt === finalAttempt,
    source: "batch"
  };
}

function runIdFor(loaded: Extract<RunLoadResult, { ok: true }>, root: string): string {
  return "runId" in loaded.run ? loaded.run.runId : path.relative(root, loaded.path).split(path.sep).join("/");
}

async function configurationState(root: string, warnings: TuiWarning[]): Promise<TuiSnapshot["configuration"]> {
  try {
    await loadConfig(root);
    return "available";
  } catch (error) {
    const missing = error instanceof AriadneError && error.code === "CONFIG_NOT_FOUND";
    warnings.push(structuredWarning(
      missing ? "Configuration not found. History remains available." : `Configuration could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      warnings.length,
      { code: missing ? "configuration-missing" : "corrupt-record", path: "ariadne.yml" }
    ));
    return missing ? "missing" : "invalid";
  }
}

async function resultStates(
  root: string,
  runs: Array<Extract<RunLoadResult, { ok: true }>>,
  promotions: PromotionRecord[],
  warnings: TuiWarning[]
): Promise<Map<string, ResultState>> {
  const states = new Map<string, ResultState>();
  await Promise.all(runs.map(async (loaded) => {
    if (!("runId" in loaded.run)) return;
    const run = loaded.run;
    const applicable = run.changeArtifact?.applicable ?? false;
    states.set(run.runId, stateFromPromotions(promotions, run.runId, applicable));
    if (!applicable) return;
    const revision = run.changeArtifact?.resultRevision;
    const exists = revision ? await resultRefExists(root, revision, run.runId) : false;
    if (!exists) warnings.push(structuredWarning(`Run ${run.runId} is applicable, but its managed result ref is missing or does not match.`, warnings.length, { code: "missing-result-ref", recordId: run.runId }));
  }));
  return states;
}

function fallbackTaskState(value: string): TaskHistoryEntry["state"] {
  const known = new Set(["pending", "ready", "running", "retry_wait", "succeeded", "failed", "blocked", "skipped", "interrupted", "incomplete", "passed"]);
  return known.has(value) ? value as TaskHistoryEntry["state"] : "incomplete";
}

export class AriadneTuiService implements TuiDataService {
  readonly root: string;
  readonly registry = new ActiveWorkflowRegistry();

  constructor(cwd: string) {
    this.root = path.resolve(cwd);
  }

  async loadSnapshot(): Promise<TuiSnapshot> {
    const root = await fs.realpath(this.root).catch(() => this.root);
    const warnings: TuiWarning[] = [];
    const [configuration, batchHistory, runHistory, promotionItems, workspaceItems, reviewItems, workspaceDetails] = await Promise.all([
      configurationState(root, warnings),
      loadBatchHistory(root),
      loadRunHistory(root),
      loadPromotions(root),
      listWorkspaces(root),
      listReviewResults(root),
      listManagedWorkspaces(root)
    ]);

    for (const [index, message] of [...batchHistory.warnings, ...runHistory.warnings].entries()) warnings.push(structuredWarning(message, warnings.length + index));
    const promotions = promotionItems.flatMap((item) => item.record ? [item.record] : []);
    for (const item of promotionItems) if (item.warning) warnings.push(structuredWarning(item.warning, warnings.length, { path: path.relative(root, item.path) }));
    const workspaces = workspaceItems.flatMap((item) => item.record ? [item.record] : []);
    for (const item of workspaceItems) if (item.warning) warnings.push(structuredWarning(item.warning, warnings.length, { path: path.relative(root, item.metadataPath) }));
    for (const message of [...reviewItems.warnings, ...workspaceDetails.warnings]) warnings.push(structuredWarning(message, warnings.length));
    await Promise.all(workspaces.map(async (workspace) => {
      if (["removed", "failed"].includes(workspace.state)) return;
      const workspacePath = path.resolve(root, workspace.path);
      const safe = isPathInside(root, await canonicalizePath(workspacePath));
      if (!safe) warnings.push(structuredWarning(`Workspace ${workspace.workspaceId} resolves outside the project root: ${workspace.path}`, warnings.length, { code: "unsafe-path", recordId: workspace.workspaceId }));
      else if (!(await fs.pathExists(workspacePath))) warnings.push(structuredWarning(`Managed worktree is missing for workspace ${workspace.workspaceId}: ${workspace.path}`, warnings.length, { code: "missing-worktree", recordId: workspace.workspaceId }));
    }));

    const validRuns = runHistory.records.filter((record): record is Extract<RunLoadResult, { ok: true }> => record.ok);
    const runStates = await resultStates(root, validRuns, promotions, warnings);
    const runById = new Map(validRuns.filter((record) => "runId" in record.run).map((record) => [(record.run as RunRecord).runId, record]));
    const validBatches = batchHistory.records.filter((record): record is Extract<(typeof batchHistory.records)[number], { ok: true }> => record.ok);
    const batches: BatchHistoryEntry[] = validBatches.map((loaded) => {
      const resultStateMap: Record<string, ResultState> = {};
      const relatedRunIds = loaded.batch.tasks.flatMap((task) => task.attempts.map((attempt) => attempt.runId));
      for (const runId of relatedRunIds) resultStateMap[runId] = runStates.get(runId) ?? "not-applicable";
      return {
        key: loaded.batch.batchId,
        record: loaded.batch,
        report: buildBatchReportModel(loaded.batch, loaded.warnings, path.relative(root, loaded.path), promotions.filter((promotion) => promotion.includedRunIds.some((runId) => relatedRunIds.includes(runId)) || relatedRunIds.includes(promotion.runId))),
        resultStates: resultStateMap
      };
    }).sort((left, right) => right.record.startedAt.localeCompare(left.record.startedAt) || right.key.localeCompare(left.key));

    const tasks: TaskHistoryEntry[] = [];
    const referencedRuns = new Set<string>();
    for (const batch of batches) {
      for (const task of batch.record.tasks) {
        const key = `${batch.key}:${task.id}`;
        const attempts = task.attempts.map((attempt) => {
          referencedRuns.add(attempt.runId);
          return batchAttempt(key, attempt, task.finalAttempt);
        });
        const final = attempts.find((attempt) => attempt.final) ?? attempts.at(-1);
        const loadedRun = final ? runById.get(final.runId) : undefined;
        const modernRun = loadedRun && "runId" in loadedRun.run ? loadedRun.run : undefined;
        tasks.push({
          key,
          source: "batch",
          batchId: batch.key,
          taskId: task.id,
          name: task.name,
          state: task.state,
          outcome: task.finalOutcome ?? final?.outcome ?? "unknown",
          startedAt: final?.startedAt ?? batch.record.startedAt,
          durationMs: attempts.reduce((total, attempt) => total + attempt.durationMs, 0),
          score: final?.score ?? null,
          workspaceState: modernRun?.workspace?.state,
          resultState: final ? runStates.get(final.runId) ?? "not-applicable" : "not-applicable",
          attempts,
          finalAttempt: task.finalAttempt,
          warnings: task.warnings.map((message, index) => structuredWarning(message, index, { recordId: task.id }))
        });
      }
    }

    for (const loaded of validRuns) {
      const id = runIdFor(loaded, root);
      if (referencedRuns.has(id)) continue;
      const report = buildReportModel(loaded.run, loaded.warnings, path.relative(root, loaded.path));
      const source = loaded.legacy ? "legacy" as const : "standalone" as const;
      report.tasks.forEach((task, taskIndex) => {
        const key = `${path.relative(root, loaded.path).split(path.sep).join("/")}#${taskIndex}:${task.id}`;
        const attempt = syntheticAttempt({
          key: `${key}:attempt:1`, path: path.relative(root, loaded.path).split(path.sep).join("/"), runId: id, taskIndex,
          status: task.status === "passed" ? "passed" : task.status === "running" ? "running" : task.status === "interrupted" ? "interrupted" : task.status === "incomplete" ? "incomplete" : "failed",
          outcome: taskOutcome(task.outcome), score: task.score, startedAt: report.startedAt, completedAt: report.completedAt ?? report.startedAt,
          durationMs: task.durationMs, source
        });
        const modernRun = "runId" in loaded.run ? loaded.run : undefined;
        tasks.push({
          key, source, taskId: task.id, name: task.name, state: fallbackTaskState(task.status), outcome: taskOutcome(task.outcome),
          startedAt: report.startedAt, durationMs: task.durationMs, score: task.score, workspaceState: modernRun?.workspace?.state,
          resultState: modernRun ? runStates.get(modernRun.runId) ?? "not-applicable" : "not-applicable", attempts: [attempt], finalAttempt: 1,
          warnings: loaded.warnings.map((message, index) => structuredWarning(message, index, { recordId: id }))
        });
      });
    }
    tasks.sort((left, right) => right.startedAt.localeCompare(left.startedAt) || left.key.localeCompare(right.key));

    if (batches.length === 0 && tasks.length === 0) warnings.push(structuredWarning("No Ariadne history found. Run ariadne run to create the first workflow.", warnings.length, { code: "history-empty" }));
    const finalWarnings = deduplicateWarnings(warnings);
    return {
      loadedAt: new Date().toISOString(), configuration, batches, tasks, workspaces, promotions,
      results: reviewItems.results, workspaceDetails: workspaceDetails.workspaces, warnings: finalWarnings,
      attention: {
        unappliedResults: reviewItems.results.filter((result) => result.resultState === "unapplied" && result.final).length,
        conflictedResults: reviewItems.results.filter((result) => result.resultState === "conflicted" && result.final).length,
        applicationFailures: reviewItems.results.filter((result) => result.resultState === "application-failed" && result.final).length,
        ineligibleResults: reviewItems.results.filter((result) => result.resultState === "apply-ineligible" && result.final).length,
        missingOrCorruptResults: reviewItems.results.filter((result) => ["missing-artifact", "corrupt", "unavailable"].includes(result.resultState) && result.final).length,
        retainedWorktrees: workspaces.filter((workspace) => workspace.state === "retained").length,
        staleWorktrees: workspaceDetails.workspaces.filter((workspace) => workspace.state === "stale" || workspace.state === "missing").length,
        cleanupFailures: workspaceDetails.cleanupFailures,
        failedWorkflows: batches.filter((batch) => ["partially_failed", "failed", "interrupted", "abandoned"].includes(batch.record.batchStatus)).length,
        warnings: finalWarnings.length
      }
    };
  }

  async loadAttempt(reference: AttemptReference): Promise<AttemptDetail> {
    const root = await fs.realpath(this.root).catch(() => this.root);
    const candidate = path.resolve(root, reference.manifestPath);
    if (!isPathInside(root, await canonicalizePath(candidate))) throw new Error("Attempt manifest path leaves the project root.");
    const loaded = await loadRunFile(candidate);
    if (!loaded.ok) throw new Error(loaded.error);
    const report = buildReportModel(loaded.run, loaded.warnings, reference.manifestPath);
    const promotionItems = await loadPromotions(root);
    const promotions = promotionItems.flatMap((item) => item.record ? [item.record] : []);
    const runId = "runId" in loaded.run ? loaded.run.runId : reference.runId;
    report.promotions = promotionsForRun(promotions, runId);
    const modernRun = "runId" in loaded.run ? loaded.run : undefined;
    const applicable = modernRun?.changeArtifact?.applicable ?? false;
    if (applicable && modernRun?.changeArtifact?.resultRevision) await resultRefExists(root, modernRun.changeArtifact.resultRevision, runId);
    return {
      reference,
      report,
      taskIndex: Math.min(reference.taskIndex ?? 0, Math.max(0, report.tasks.length - 1)),
      resultState: stateFromPromotions(promotions, runId, applicable)
    };
  }

  loadLogPreview(relativePath: string) {
    return readLogPreview(this.root, relativePath);
  }

  loadResultSummary(runId: string) { return loadResultSummary(this.root, runId); }
  loadFileDiff(runId: string, changeIdOrPath: string, cursor?: string) { return loadFileDiff(this.root, runId, changeIdOrPath, cursor); }
  compareAttemptResults(leftRunId: string, rightRunId: string) { return compareAttemptResults(this.root, leftRunId, rightRunId); }
  inspectApplyEligibility(runId: string) { return inspectApplyEligibility(this.root, runId); }
  previewApplyResult(runId: string) { return previewApplyResult(this.root, runId); }
  applyReviewedResult(runId: string, fingerprint: string, onProgress?: (stage: string) => void, signal?: AbortSignal) { return applyReviewedResult(this.root, runId, fingerprint, { onProgress, signal }); }
  previewDiscardResult(runId: string) { return previewDiscardResult(this.root, runId); }
  discardReviewedResult(runId: string, onProgress?: (stage: string) => void, signal?: AbortSignal) { return discardReviewedResult(this.root, runId, { onProgress, signal }); }
  previewPatchExport(runId: string) { return previewPatchExport(this.root, runId); }
  async exportPatch(runId: string, destination: string, onProgress?: (stage: string) => void, signal?: AbortSignal) { const result = await exportPatch(this.root, runId, destination, false, { onProgress, signal }); return { path: result.path }; }
  loadWorkspaceDetail(workspaceId: string) { return loadWorkspaceDetail(this.root, workspaceId); }
  previewWorkspaceCleanup(workspaceId: string) { return previewWorkspaceCleanup(this.root, workspaceId); }
  previewEligibleWorkspaceCleanup() { return previewEligibleWorkspaceCleanup(this.root); }
  cleanWorkspace(workspaceId: string, onProgress?: (stage: string) => void, signal?: AbortSignal) { return cleanWorkspace(this.root, workspaceId, { onProgress, signal }); }
  cleanEligibleWorkspaces(onProgress?: (stage: string) => void, signal?: AbortSignal) { return cleanEligibleWorkspaces(this.root, { onProgress, signal }); }

  inspectWorkflowOptions() {
    return inspectWorkflowOptions({ cwd: this.root });
  }

  createWorkflowPlanPreview(taskIds: string[], overrides: WorkflowExecutionOverrides) {
    return createWorkflowPlanPreview({ cwd: this.root, taskIds, ...overrides });
  }

  previewResumeWorkflow(batchId: string, overrides: Pick<WorkflowExecutionOverrides, "concurrency" | "allowDirtyBase">) {
    return previewResumeWorkflow({ cwd: this.root, sourceBatchId: batchId, ...overrides });
  }

  previewRerunWorkflow(batchId: string, mode: "failed" | "failed-branch" | "all", overrides: WorkflowExecutionOverrides) {
    return previewRerunWorkflow({ cwd: this.root, sourceBatchId: batchId, mode, ...overrides });
  }

  startWorkflowExecution(request: Omit<WorkflowLaunchRequest, "cwd">) {
    return this.registry.start({ ...request, cwd: this.root } as WorkflowLaunchRequest);
  }

  async cancellationTimeoutMs() {
    const loaded = await loadConfig(this.root);
    return Math.min(30_000, 2 * loaded.config.execution.termination_grace_ms + 5_000);
  }

  async loadBatch(batchId: string) {
    const filePath = await resolveBatchFile(this.root, batchId);
    const loaded = await loadBatchFile(filePath, this.root);
    if (!loaded.ok) throw new Error(loaded.error);
    return loaded.batch;
  }
}
