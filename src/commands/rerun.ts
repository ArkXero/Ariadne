import { startWorkflowExecution } from "../core/workflow-application.js";
import { buildBatchReportModel, formatBatchCompletion } from "../core/workflow-report.js";
import { withWorkflowSignals } from "./workflow-signals.js";
import type { BatchRecord, FailureMode, IsolationStrategy } from "../types/index.js";

export async function rerunCommand(options: { cwd: string; batchId: string; configPath?: string; mode: "failed" | "blocked" | "all" | "tasks"; taskIds?: string[]; concurrency?: number; failureMode?: FailureMode; isolation?: IsolationStrategy; allowDirtyBase?: boolean; json?: boolean; quiet?: boolean }): Promise<{ batch: BatchRecord; signal?: NodeJS.Signals }> {
  const execution = await withWorkflowSignals(async (signal) => {
    return (await startWorkflowExecution({
      kind: "rerun", cwd: options.cwd, sourceBatchId: options.batchId, configPath: options.configPath, mode: options.mode,
      taskIds: options.taskIds,
      concurrency: options.concurrency, failureMode: options.failureMode, isolation: options.isolation, allowDirtyBase: options.allowDirtyBase, signal,
      onProgress: options.quiet ? undefined : (message) => process.stderr.write(`${message}\n`)
    })).completion;
  });
  process.stdout.write(options.json ? `${JSON.stringify(buildBatchReportModel(execution.value), null, 2)}\n` : `${formatBatchCompletion(execution.value)}\n`);
  return { batch: execution.value, ...(execution.signal ? { signal: execution.signal } : {}) };
}
