import { startWorkflowExecution } from "../core/workflow-application.js";
import { buildBatchReportModel, formatBatchCompletion } from "../core/workflow-report.js";
import { withWorkflowSignals } from "./workflow-signals.js";
import type { BatchRecord, FailureCategory, FailureMode, IsolationStrategy, RunRecord, TaskOutcome } from "../types/index.js";

const OUTCOME_EXIT_CODE: Record<TaskOutcome, number> = {
  passed: 0,
  agent_failed: 10,
  timeout: 11,
  verification_failed: 12,
  policy_failed: 13,
  preparation_failed: 14,
  interrupted: 130,
  internal_failed: 70
};

const FAILURE_EXIT_CODE: Partial<Record<FailureCategory, number>> = {
  configuration: 2,
  task_loading: 2,
  task_selection: 3,
  repository_validation: 4,
  workspace_preparation: 14,
  workspace_management: 14,
  promotion_conflict: 15,
  persistence: 70,
  internal: 70
};

export function exitCodeForBatch(batch: BatchRecord, signal?: NodeJS.Signals): number {
  if (signal === "SIGTERM") return 143;
  if (signal === "SIGINT") return 130;
  if (batch.failures.some((item) => item.category === "internal" || item.category === "persistence")) return 70;
  const planningFailure = batch.failures.find((item) => FAILURE_EXIT_CODE[item.category] !== undefined);
  if (planningFailure) return FAILURE_EXIT_CODE[planningFailure.category] ?? 70;
  if (!["passed", "policy_failed"].includes(batch.summary.outcome)) return OUTCOME_EXIT_CODE[batch.summary.outcome];
  if (batch.failures.some((item) => item.code === "PARALLEL_SAFETY_VIOLATION")) return 13;
  return OUTCOME_EXIT_CODE[batch.summary.outcome];
}

export function exitCodeForRun(run: RunRecord, signal?: NodeJS.Signals): number {
  if (signal === "SIGTERM") return 143;
  if (signal === "SIGINT") return 130;
  const preRunFailure = run.failures.find((failure) => FAILURE_EXIT_CODE[failure.category] !== undefined);
  return preRunFailure ? FAILURE_EXIT_CODE[preRunFailure.category]! : OUTCOME_EXIT_CODE[run.summary.outcome];
}

export async function runCommand(options: {
  cwd: string;
  configPath: string;
  taskIds?: string[];
  concurrency?: number;
  failureMode?: FailureMode;
  isolation?: IsolationStrategy;
  allowDirtyBase?: boolean;
  json?: boolean;
  quiet?: boolean;
}): Promise<{ batch: BatchRecord; signal?: NodeJS.Signals }> {
  const execution = await withWorkflowSignals(async (signal) => (await startWorkflowExecution({
      kind: "run",
      cwd: options.cwd,
      configPath: options.configPath,
      taskIds: options.taskIds,
      concurrency: options.concurrency,
      failureMode: options.failureMode,
      isolation: options.isolation,
      allowDirtyBase: options.allowDirtyBase,
      signal,
      onProgress: options.quiet ? undefined : (message) => process.stderr.write(`${message}\n`)
    })).completion);
  process.stdout.write(options.json
    ? `${JSON.stringify(buildBatchReportModel(execution.value, [], execution.value.artifacts.manifest), null, 2)}\n`
    : `${formatBatchCompletion(execution.value)}\n`);
  return { batch: execution.value, ...(execution.signal ? { signal: execution.signal } : {}) };
}
