import path from "node:path";
import { BENCHMARK_JUDGE_FAILURE_EXIT_CODE, runBenchmark } from "../core/benchmark.js";
import { buildReportModel } from "../core/report.js";
import { buildBatchReportModel } from "../core/workflow-report.js";
import { exitCodeForBatch } from "./run.js";
import { withWorkflowSignals } from "./workflow-signals.js";
import type { BatchRecord, BenchmarkFailureAction, BenchmarkResult } from "../types/index.js";

function action(value: BenchmarkFailureAction | undefined): string {
  if (!value) return "not applicable";
  return typeof value === "string" ? value : `cap ${value.cap}`;
}

export function formatBenchmarkCompletion(benchmark: BenchmarkResult, batch: BatchRecord): string {
  return [
    "Ariadne professional benchmark completed",
    `Task: ${benchmark.taskId}`,
    `Benchmark: ${benchmark.benchmarkId}`,
    `Execution outcome: ${benchmark.executionOutcome}`,
    `Policy score: ${benchmark.policyScore}`,
    `Benchmark status: ${benchmark.status}`,
    `Benchmark raw score: ${benchmark.rawScore ?? "n/a"}`,
    `Failure policy: ${action(benchmark.failurePolicy?.action)}`,
    `Effective score: ${benchmark.effectiveScore ?? "n/a"}`,
    `Qualification: ${benchmark.qualification}`,
    `Candidate model: ${benchmark.candidateModel}`,
    `Judge model: ${benchmark.judgeModel}`,
    ...(benchmark.reason ? [`Reason: ${benchmark.reason}`] : []),
    ...(benchmark.failure ? [`Benchmark failure: [${benchmark.failure.code}] ${benchmark.failure.message}`] : []),
    `Batch: ${batch.batchId}`,
    `Manifest: ${batch.artifacts.manifest}`
  ].join("\n");
}

export function exitCodeForBenchmark(batch: BatchRecord, benchmark: BenchmarkResult, signal?: NodeJS.Signals): number {
  const executionCode = exitCodeForBatch(batch, signal);
  if (executionCode !== 0) return executionCode;
  return benchmark.status === "failed" ? BENCHMARK_JUDGE_FAILURE_EXIT_CODE : 0;
}

export async function benchmarkCommand(options: {
  cwd: string;
  configPath: string;
  taskId: string;
  json?: boolean;
  quiet?: boolean;
}): Promise<{ batch: BatchRecord; benchmark: BenchmarkResult; signal?: NodeJS.Signals }> {
  const execution = await withWorkflowSignals(async (signal) => runBenchmark({
    cwd: options.cwd,
    configPath: options.configPath,
    taskId: options.taskId,
    signal,
    onProgress: options.quiet ? undefined : (message) => process.stderr.write(`${message}\n`)
  }));
  const value = execution.value;
  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      kind: "benchmark",
      schemaVersion: 1,
      benchmark: value.benchmark,
      batch: buildBatchReportModel(value.batch, [], value.batch.artifacts.manifest),
      ...(value.run ? { run: buildReportModel(value.run, [], value.runPath ? path.relative(options.cwd, value.runPath).split(path.sep).join("/") : undefined) } : {})
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatBenchmarkCompletion(value.benchmark, value.batch)}\n`);
  }
  return { batch: value.batch, benchmark: value.benchmark, ...(execution.signal ? { signal: execution.signal } : {}) };
}
