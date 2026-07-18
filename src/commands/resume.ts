import { startWorkflowExecution } from "../core/workflow-application.js";
import { buildBatchReportModel, formatBatchCompletion } from "../core/workflow-report.js";
import { withWorkflowSignals } from "./workflow-signals.js";
import type { BatchRecord } from "../types/index.js";

export async function resumeCommand(options: { cwd: string; batchId: string; configPath?: string; concurrency?: number; allowDirtyBase?: boolean; json?: boolean; quiet?: boolean }): Promise<{ batch: BatchRecord; signal?: NodeJS.Signals }> {
  const execution = await withWorkflowSignals(async (signal) => (await startWorkflowExecution({
    kind: "resume", cwd: options.cwd, sourceBatchId: options.batchId, configPath: options.configPath, concurrency: options.concurrency, allowDirtyBase: options.allowDirtyBase, signal,
    onProgress: options.quiet ? undefined : (message) => process.stderr.write(`${message}\n`)
  })).completion);
  process.stdout.write(options.json ? `${JSON.stringify(buildBatchReportModel(execution.value), null, 2)}\n` : `${formatBatchCompletion(execution.value)}\n`);
  return { batch: execution.value, ...(execution.signal ? { signal: execution.signal } : {}) };
}
