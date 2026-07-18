import path from "node:path";
import fs from "fs-extra";
import { loadBatchFile, resolveBatchFile } from "./batch-reader.js";
import { AriadneError } from "./errors.js";
import { prepareWorkflow, runWorkflow } from "./workflow-runner.js";
import { resultRefExists } from "./workspace-manager.js";
import type { WorkflowRuntimeEmitter } from "./workflow-runtime.js";
import type { BatchRecord, BatchTaskRecord, FailureMode, IsolationStrategy } from "../types/index.js";

async function sourceBatch(cwd: string, idOrPath: string): Promise<{ batch: BatchRecord; warnings: string[] }> {
  const filePath = await resolveBatchFile(cwd, idOrPath);
  const loaded = await loadBatchFile(filePath, cwd);
  if (!loaded.ok) {
    throw new AriadneError({
      category: loaded.code === "missing" ? "task_selection" : "persistence",
      code: loaded.code === "missing" ? "BATCH_NOT_FOUND" : "BATCH_RECORD_UNREADABLE",
      stage: "loading", source: filePath, message: loaded.error,
      correction: "Choose a valid batch ID from \"ariadne list --batches\"."
    });
  }
  return { batch: loaded.batch, warnings: loaded.warnings };
}

export async function resumeWorkflow(options: {
  cwd: string;
  batchId: string;
  configPath?: string;
  concurrency?: number;
  allowDirtyBase?: boolean;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  executionBatchId?: string;
  startedAt?: Date;
  runtime?: WorkflowRuntimeEmitter;
}): Promise<BatchRecord & { outputPath: string }> {
  const source = await sourceBatch(options.cwd, options.batchId);
  if (["succeeded", "succeeded_with_warnings"].includes(source.batch.batchStatus)) {
    throw new AriadneError({
      category: "task_selection", code: "BATCH_ALREADY_SUCCEEDED", stage: "validated",
      message: `Batch ${source.batch.batchId} already succeeded and cannot be resumed.`, correction: "Use ariadne rerun when you want a new execution."
    });
  }
  if (!source.batch.plan || !source.batch.configFingerprint) {
    throw new AriadneError({ category: "persistence", code: "BATCH_PLAN_MISSING", stage: "validated", message: `Batch ${source.batch.batchId} has no resumable workflow plan.`, correction: "Rerun the workflow from the current configuration." });
  }
  const prepared = await prepareWorkflow({
    cwd: options.cwd,
    configPath: options.configPath ?? source.batch.configPath,
    taskIds: source.batch.plan.selectedRoots,
    concurrency: options.concurrency ?? source.batch.plan.concurrency,
    failureMode: source.batch.plan.failureMode,
    isolation: source.batch.plan.isolation,
    allowDirtyBase: options.allowDirtyBase ?? source.batch.plan.dirtyBaseAcknowledged
  });
  if (prepared.plan.configFingerprint !== source.batch.configFingerprint) {
    throw new AriadneError({
      category: "configuration", code: "RESUME_CONFIG_CHANGED", stage: "validated",
      message: `Batch ${source.batch.batchId} does not match the current workflow configuration.`,
      expected: source.batch.configFingerprint, offendingValue: prepared.plan.configFingerprint,
      correction: "Restore the original graph, prompts, commands, policies, retries, and failure mode, or use ariadne rerun."
    });
  }
  if ((source.batch.sourceHead ?? undefined) !== (prepared.sourceHead ?? undefined)) {
    throw new AriadneError({
      category: "repository_validation", code: "RESUME_HEAD_CHANGED", stage: "validated",
      message: "The Git HEAD changed since the source batch was created.", expected: source.batch.sourceHead ?? "no Git HEAD", offendingValue: prepared.sourceHead ?? "no Git HEAD",
      correction: "Restore the original HEAD or use ariadne rerun against the current repository."
    });
  }

  const root = prepared.projectRoot;
  let requeued = 0;
  const seeds: BatchTaskRecord[] = [];
  for (const task of source.batch.tasks) {
    const final = task.finalAttempt === undefined ? undefined : task.attempts.find((attempt) => attempt.attempt === task.finalAttempt);
    const missing = final ? !fs.existsSync(path.resolve(root, final.manifest)) : false;
    const missingResult = source.batch.plan.isolation === "worktree" && task.state === "succeeded" && Boolean(final?.resultRevision) && !await resultRefExists(root, final!.resultRevision!, final!.runId);
    const reusable = task.state === "succeeded" && !missing && !missingResult;
    const retryableFailure = task.state === "failed" && final?.retryEligible === true;
    const shouldRequeue = missing || missingResult || retryableFailure || ["interrupted", "incomplete", "blocked", "skipped", "pending", "ready", "running", "retry_wait"].includes(task.state);
    if (shouldRequeue) requeued += 1;
    seeds.push({
      ...task,
      state: reusable ? "succeeded" : shouldRequeue ? "pending" : task.state,
      ...(reusable || !shouldRequeue ? (task.finalOutcome ? { finalOutcome: task.finalOutcome } : {}) : { finalOutcome: undefined }),
      attempts: task.attempts.map((attempt) => ({ ...attempt })),
      warnings: [...task.warnings, ...(shouldRequeue ? [source.batch.plan.isolation === "worktree" ? "Resume creates a fresh isolated workspace; uncertain workspaces are never reused." : "Resume preserves the current shared working tree; Ariadne does not reset prior attempt changes."] : []), ...(missing ? [`Child record ${final?.manifest} is missing and will be requeued.`] : []), ...(missingResult ? ["A successful result ref is missing and the task will be requeued."] : []), ...(["running", "retry_wait"].includes(task.state) ? [`Stale ${task.state} state was reconciled without rewriting the source batch.`] : [])],
      ...(task.finalAttempt ? { finalAttempt: task.finalAttempt } : {}),
      blockReason: undefined,
      skipReason: undefined
    });
  }
  if (requeued === 0) {
    throw new AriadneError({
      category: "task_selection", code: "BATCH_NOT_RESUMABLE", stage: "validated",
      message: `Batch ${source.batch.batchId} has no incomplete, interrupted, blocked, skipped, missing, or retry-eligible failed tasks.`,
      correction: "Use ariadne rerun to start a new workflow from current configuration."
    });
  }
  return runWorkflow({
    cwd: options.cwd, configPath: options.configPath ?? source.batch.configPath,
    taskIds: source.batch.plan.selectedRoots, concurrency: options.concurrency ?? source.batch.plan.concurrency,
    failureMode: source.batch.plan.failureMode, signal: options.signal, onProgress: options.onProgress,
    isolation: source.batch.plan.isolation, allowDirtyBase: options.allowDirtyBase ?? source.batch.plan.dirtyBaseAcknowledged,
    relation: { kind: "resume", sourceBatchId: source.batch.batchId }, seedTasks: seeds, initialWarnings: source.warnings,
    resumeCompatibility: { configFingerprint: source.batch.configFingerprint, sourceHead: source.batch.sourceHead },
    batchId: options.executionBatchId, startedAt: options.startedAt, runtime: options.runtime, prepared
  });
}

export async function rerunWorkflow(options: {
  cwd: string;
  batchId: string;
  configPath?: string;
  mode: "failed" | "blocked" | "all" | "tasks";
  taskIds?: string[];
  concurrency?: number;
  failureMode?: FailureMode;
  isolation?: IsolationStrategy;
  allowDirtyBase?: boolean;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  executionBatchId?: string;
  startedAt?: Date;
  runtime?: WorkflowRuntimeEmitter;
}): Promise<BatchRecord & { outputPath: string }> {
  const source = await sourceBatch(options.cwd, options.batchId);
  if (!source.batch.plan) throw new AriadneError({ category: "persistence", code: "BATCH_PLAN_MISSING", stage: "validated", message: `Batch ${source.batch.batchId} has no rerunnable workflow plan.`, correction: "Run a new workflow from current configuration." });
  const selected = options.mode === "all" ? source.batch.plan.selectedRoots
    : options.mode === "failed" ? source.batch.tasks.filter((task) => task.state === "failed").map((task) => task.id)
      : options.mode === "blocked" ? source.batch.tasks.filter((task) => task.state === "blocked").map((task) => task.id)
        : options.taskIds ?? [];
  const sourceIds = new Set(source.batch.tasks.map((task) => task.id.toLowerCase()));
  const unknown = selected.filter((id) => !sourceIds.has(id.toLowerCase()));
  if (unknown.length > 0) throw new AriadneError({ category: "task_selection", code: "RERUN_TASK_NOT_IN_BATCH", stage: "validated", message: `Tasks were not part of source batch ${source.batch.batchId}: ${unknown.join(", ")}.`, correction: `Choose from: ${source.batch.tasks.map((task) => task.id).join(", ")}.` });
  if (selected.length === 0) throw new AriadneError({ category: "task_selection", code: "RERUN_SELECTION_EMPTY", stage: "validated", message: `Rerun mode ${options.mode} selected no tasks from batch ${source.batch.batchId}.`, correction: "Choose a different rerun mode or use --task with a task from the source batch." });
  return runWorkflow({
    cwd: options.cwd, configPath: options.configPath ?? source.batch.configPath, taskIds: selected,
    concurrency: options.concurrency, failureMode: options.failureMode, isolation: options.isolation, allowDirtyBase: options.allowDirtyBase, signal: options.signal, onProgress: options.onProgress,
    relation: { kind: "rerun", sourceBatchId: source.batch.batchId }, initialWarnings: source.warnings,
    batchId: options.executionBatchId, startedAt: options.startedAt, runtime: options.runtime
  });
}
