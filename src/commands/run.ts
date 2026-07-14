import { formatRunCompletion, buildReportModel } from "../core/report.js";
import { runAriadne } from "../core/runner.js";
import type { FailureCategory, RunRecord, TaskOutcome } from "../types/index.js";

const OUTCOME_EXIT_CODE: Record<TaskOutcome, number> = {
  passed: 0,
  agent_failed: 10,
  timeout: 11,
  verification_failed: 12,
  policy_failed: 13,
  interrupted: 130,
  internal_failed: 70
};

const FAILURE_EXIT_CODE: Partial<Record<FailureCategory, number>> = {
  configuration: 2,
  task_loading: 2,
  task_selection: 3,
  repository_validation: 4,
  persistence: 70,
  internal: 70
};

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
  json?: boolean;
  quiet?: boolean;
}): Promise<{ run: RunRecord; signal?: NodeJS.Signals }> {
  const controller = new AbortController();
  let receivedSignal: NodeJS.Signals | undefined;
  let signalCount = 0;
  const handler = (signal: NodeJS.Signals) => {
    receivedSignal = signal;
    signalCount += 1;
    if (signalCount === 1) controller.abort(signal);
    else process.exit(signal === "SIGTERM" ? 143 : 130);
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  try {
    const run = await runAriadne({
      cwd: options.cwd,
      configPath: options.configPath,
      taskIds: options.taskIds,
      signal: controller.signal,
      onProgress: options.quiet ? undefined : (message) => process.stderr.write(`${message}\n`)
    });
    process.stdout.write(options.json
      ? `${JSON.stringify(buildReportModel(run, [], run.artifacts.manifest), null, 2)}\n`
      : `${formatRunCompletion(run)}\n`);
    return { run, ...(receivedSignal ? { signal: receivedSignal } : {}) };
  } finally {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  }
}
