import path from "node:path";
import fs from "fs-extra";
import { getRunSchemaVersion } from "../schema/run-record.js";
import type { AriadneRun, CommandExecution, ScoreCheck, TaskRunResult, TaskScoreStatus } from "../types/index.js";

const LOG_TAIL_LINES = 8;

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function checkStatusLabel(passed: boolean): string {
  return passed ? "PASS" : "FAIL";
}

function scoreStatus(result: TaskRunResult): TaskScoreStatus {
  return result.score.status ?? (result.score.passed ? "passed" : "check_failed");
}

function statusLabel(status: TaskScoreStatus): string {
  return status.toUpperCase();
}

function passFailLabel(passed: boolean): string {
  return passed ? "passed" : "failed";
}

function runStatus(run: AriadneRun): TaskScoreStatus {
  const failed = run.summary?.failed ?? runResults(run).filter((result) => !result.score?.passed).length;
  return run.summary?.status ?? (failed > 0 ? "check_failed" : "passed");
}

function formatCheck(check: ScoreCheck): string {
  return `${checkStatusLabel(check.passed)} ${check.name}: ${check.message}`;
}

function usefulTailLines(value: string, limit = LOG_TAIL_LINES): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-limit);
}

function commandReason(command: CommandExecution): string {
  if (command.timedOut) {
    return "command timed out";
  }

  return usefulTailLines(command.stderr, 1)[0]
    ?? usefulTailLines(command.stdout, 1)[0]
    ?? `command exited with code ${command.exitCode}`;
}

function commandPassed(command: CommandExecution): boolean {
  return command.exitCode === 0 && !command.timedOut;
}

function commandStatus(command: CommandExecution): string {
  if (command.timedOut) {
    return "timeout";
  }

  return passFailLabel(command.exitCode === 0);
}

function failedVerificationCommands(result: TaskRunResult): CommandExecution[] {
  return (result.verification ?? []).filter((command) => !commandPassed(command));
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}

function formatRows(rows: Array<[string, string]>, indent = "  "): string[] {
  if (rows.length === 0) {
    return [];
  }

  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${indent}${label.padEnd(labelWidth)} ${value}`);
}

function formatOutputTail(label: string, output: string): string[] {
  const lines = usefulTailLines(output);
  if (lines.length === 0) {
    return [];
  }

  return [
    `  ${label} (last ${lines.length} useful lines):`,
    ...lines.map((line) => `    ${line}`)
  ];
}

function humanCheckName(name: string): string {
  const names: Record<string, string> = {
    forbidden_files: "forbidden files",
    max_changed_files: "max files",
    max_diff_lines: "max diff",
    forbidden_commands: "forbidden commands"
  };

  return names[name] ?? name.replace(/_/g, " ");
}

function reportPathForDisplay(run: AriadneRun & { outputPath?: string }): string {
  if (!run.outputPath) {
    return "";
  }

  const relativePath = path.relative(run.cwd, run.outputPath);
  return relativePath.startsWith("..") ? run.outputPath : relativePath;
}

function runIdForDisplay(run: AriadneRun & { outputPath?: string }): string {
  if (!run.outputPath) {
    return run.startedAt;
  }

  return path.basename(run.outputPath, ".json");
}

function resultDurationMs(result: TaskRunResult): number {
  return result.durationMs
    ?? result.agent.runtimeMs + (result.verification ?? []).reduce((total, command) => total + command.runtimeMs, 0);
}

function changedFiles(result: TaskRunResult): string[] {
  return result.trace?.changedFiles ?? [];
}

function forbiddenFileChanges(result: TaskRunResult): string[] {
  return result.trace?.forbiddenFileChanges ?? [];
}

function diffLineCount(result: TaskRunResult): number {
  return result.trace?.diffLineCount ?? 0;
}

function commandsObserved(result: TaskRunResult): string[] {
  return result.trace?.commandsObserved ?? [];
}

function runResults(run: AriadneRun): TaskRunResult[] {
  return run.results ?? [];
}

function summaryTotal(run: AriadneRun): number {
  return run.summary?.total ?? runResults(run).length;
}

function summaryPassed(run: AriadneRun): number {
  return run.summary?.passed ?? runResults(run).filter((result) => result.score?.passed).length;
}

function summaryFailed(run: AriadneRun): number {
  return run.summary?.failed ?? runResults(run).filter((result) => !result.score?.passed).length;
}

export async function findLatestRunFile(cwd: string): Promise<string> {
  const runsDir = path.join(cwd, ".ariadne", "runs");

  if (!(await fs.pathExists(runsDir))) {
    throw new Error(`Runs directory not found: ${runsDir}. Run "ariadne run" first.`);
  }

  const files = (await fs.readdir(runsDir))
    .filter((file) => file.endsWith(".json") && file !== "runs.json")
    .sort();

  if (files.length === 0) {
    throw new Error(`No run JSON files found in ${runsDir}. Run "ariadne run" first.`);
  }

  return path.join(runsDir, files.at(-1)!);
}

export async function loadRunReport(runPath: string): Promise<AriadneRun> {
  if (!(await fs.pathExists(runPath))) {
    throw new Error(`Run JSON not found: ${runPath}`);
  }

  return fs.readJson(runPath) as Promise<AriadneRun>;
}

export function formatRunCompletion(run: AriadneRun & { outputPath?: string }): string {
  const lines = [
    "Ariadne run completed",
    ""
  ];
  const reportPath = reportPathForDisplay(run);

  for (const result of runResults(run)) {
    const verificationRows = (result.verification ?? []).map((command) => [
      command.command,
      commandStatus(command)
    ] satisfies [string, string]);
    const checkRows = result.score.checks
      .filter((check) => check.name !== "agent_exit_code" && check.name !== "verification")
      .map((check) => [
        humanCheckName(check.name),
        passFailLabel(check.passed)
      ] satisfies [string, string]);
    const failedChecks = result.score.checks.filter(
      (check) => !check.passed && check.name !== "agent_exit_code" && check.name !== "verification"
    );
    const agentFailureDetails = commandPassed(result.agent)
      ? []
      : [
        `  reason: ${commandReason(result.agent)}`,
        ...formatOutputTail("stdout", result.agent.stdout),
        ...formatOutputTail("stderr", result.agent.stderr)
      ];

    lines.push(
      `Task: ${result.task.name}`,
      `Run: ${runIdForDisplay(run)}`,
      `Duration: ${formatDuration(run.durationMs)}`,
      `Task duration: ${formatDuration(resultDurationMs(result))}`,
      "",
      "Agent",
      `  command: ${result.agent.command}`,
      `  status: ${commandStatus(result.agent)}`,
      `  exit code: ${result.agent.exitCode}`,
      ...agentFailureDetails,
      "",
      "Verification",
      ...(verificationRows.length > 0 ? formatRows(verificationRows) : ["  none configured"])
    );

    for (const command of failedVerificationCommands(result)) {
      lines.push(
        `  ${command.command}`,
        `    exit code: ${command.exitCode}`,
        `    reason: ${commandReason(command)}`
      );
      lines.push(...formatOutputTail("stdout", command.stdout).map((line) => `  ${line.trimEnd()}`));
      lines.push(...formatOutputTail("stderr", command.stderr).map((line) => `  ${line.trimEnd()}`));
    }

    lines.push(
      "",
      "Checks",
      ...(checkRows.length > 0 ? formatRows(checkRows) : ["  none configured"])
    );

    for (const check of failedChecks) {
      lines.push(`  ${humanCheckName(check.name)}: ${check.message}`);
      if (check.details) {
        lines.push(`    details: ${JSON.stringify(check.details)}`);
      }
    }

    lines.push(
      "",
      `Result: ${scoreStatus(result)}`,
      ...(reportPath && runResults(run).length === 1 ? [`Report: ${reportPath}`] : [])
    );
  }

  if (runResults(run).length !== 1) {
    lines.push("", `Run result: ${runStatus(run)}`);
    if (reportPath) {
      lines.push(`Run report: ${reportPath}`);
    }
  }

  return lines.join("\n");
}

export function formatTerminalSummary(run: AriadneRun): string {
  const results = runResults(run);
  const lines = [
    `Ariadne run: ${run.startedAt}`,
    `Status: ${runStatus(run)}`,
    `Duration: ${run.durationMs}ms`,
    `Tasks: ${summaryTotal(run)}, passed: ${summaryPassed(run)}, failed: ${summaryFailed(run)}`,
    `Run schema: ${getRunSchemaVersion(run)}`,
    ""
  ];

  for (const result of results) {
    const failedVerification = failedVerificationCommands(result);

    lines.push(`${statusLabel(scoreStatus(result))} ${result.task.id} - ${result.task.name}`);
    lines.push(`  Agent: ${commandStatus(result.agent)} (exit ${result.agent.exitCode}, runtime ${result.agent.runtimeMs}ms)`);
    lines.push(`  Duration: ${formatDuration(resultDurationMs(result))}`);
    lines.push(`  Verification: ${passFailLabel(failedVerification.length === 0)} (${(result.verification ?? []).length} commands)`);
    for (const command of failedVerification) {
      lines.push(`  Failed command: ${command.command}`);
      lines.push(`  Exit code: ${command.exitCode}`);
      lines.push(`  Reason: ${commandReason(command)}`);
      lines.push(...formatOutputTail("Stdout", command.stdout));
      lines.push(...formatOutputTail("Stderr", command.stderr));
    }
    lines.push(`  Changed files: ${changedFiles(result).length}, diff lines: ${diffLineCount(result)}`);
    if (forbiddenFileChanges(result).length > 0) {
      lines.push(`  Forbidden file changes: ${forbiddenFileChanges(result).join(", ")}`);
    }

    const failedChecks = result.score.checks.filter((check) => !check.passed);
    if (failedChecks.length > 0) {
      for (const check of failedChecks) {
        lines.push(`  ${formatCheck(check)}`);
        if (check.details) {
          lines.push(`    Details: ${JSON.stringify(check.details)}`);
        }
      }
    }
  }

  return lines.join("\n");
}

function renderChecks(checks: ScoreCheck[]): string {
  return checks.map((check) => {
    const className = check.passed ? "pass" : "fail";
    const details = check.details ? `<pre>${escapeHtml(JSON.stringify(check.details, null, 2))}</pre>` : "";
    return `<li class="${className}"><strong>${escapeHtml(checkStatusLabel(check.passed))} ${escapeHtml(check.name)}</strong><span>${escapeHtml(check.message)}</span>${details}</li>`;
  }).join("");
}

function renderOutputTail(label: string, output: string): string {
  const lines = usefulTailLines(output);
  if (lines.length === 0) {
    return "";
  }

  return `<h4>${escapeHtml(label)} (last ${escapeHtml(lines.length)} useful lines)</h4><pre>${escapeHtml(lines.join("\n"))}</pre>`;
}

function renderFailedVerification(command: CommandExecution): string {
  return `<li class="fail">
    <strong>Failed verification command</strong>
    <span><code>${escapeHtml(command.command)}</code></span>
    <span>Exit code: ${escapeHtml(command.exitCode)}</span>
    <span>Reason: ${escapeHtml(commandReason(command))}</span>
    ${renderOutputTail("Stdout", command.stdout)}
    ${renderOutputTail("Stderr", command.stderr)}
  </li>`;
}

function renderVerificationFailures(result: TaskRunResult): string {
  const failedVerification = failedVerificationCommands(result);
  if (failedVerification.length === 0) {
    return "";
  }

  return `<h3>Verification Failures</h3>
  <ul>${failedVerification.map((command) => renderFailedVerification(command)).join("")}</ul>`;
}

function renderTask(result: TaskRunResult): string {
  const failedVerification = failedVerificationCommands(result);

  return `<section class="task">
  <header>
    <h2>${escapeHtml(statusLabel(scoreStatus(result)))} ${escapeHtml(result.task.id)}</h2>
    <p>${escapeHtml(result.task.name)}</p>
  </header>
  <div class="grid">
    <div><strong>Agent</strong><span>${escapeHtml(commandStatus(result.agent))}</span></div>
    <div><strong>Task duration</strong><span>${escapeHtml(formatDuration(resultDurationMs(result)))}</span></div>
    <div><strong>Agent exit</strong><span>${escapeHtml(result.agent.exitCode)}</span></div>
    <div><strong>Agent runtime</strong><span>${escapeHtml(result.agent.runtimeMs)}ms</span></div>
    <div><strong>Verification</strong><span>${escapeHtml(passFailLabel(failedVerification.length === 0))}</span></div>
    <div><strong>Verification commands</strong><span>${escapeHtml((result.verification ?? []).length)}</span></div>
    <div><strong>Changed files</strong><span>${escapeHtml(changedFiles(result).length)}</span></div>
    <div><strong>Diff lines</strong><span>${escapeHtml(diffLineCount(result))}</span></div>
  </div>
  ${renderVerificationFailures(result)}
  <h3>Checks</h3>
  <ul>${renderChecks(result.score.checks)}</ul>
  <h3>Changed files</h3>
  <pre>${escapeHtml(changedFiles(result).join("\n") || "None")}</pre>
  <h3>Forbidden file changes</h3>
  <pre>${escapeHtml(forbiddenFileChanges(result).join("\n") || "None")}</pre>
  <h3>Commands observed</h3>
  <pre>${escapeHtml(commandsObserved(result).join("\n") || "None")}</pre>
  <details>
    <summary>Agent stdout</summary>
    <pre>${escapeHtml(result.agent.stdout || "")}</pre>
  </details>
  <details>
    <summary>Agent stderr</summary>
    <pre>${escapeHtml(result.agent.stderr || "")}</pre>
  </details>
  <details>
    <summary>Git diff</summary>
    <pre>${escapeHtml(result.trace?.diff || "")}</pre>
  </details>
</section>`;
}

export function buildHtmlReport(run: AriadneRun): string {
  const results = runResults(run);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ariadne Report</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f7f4;
      --text: #1f2520;
      --muted: #697066;
      --line: #d8ddd1;
      --pass: #1d7f4f;
      --fail: #b42318;
      --panel: #ffffff;
    }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      max-width: 1040px;
      margin: 0 auto;
      padding: 40px 20px;
    }
    h1, h2, h3, p {
      margin: 0;
    }
    h1 {
      font-size: 32px;
      line-height: 1.1;
    }
    h2 {
      font-size: 20px;
    }
    h3 {
      margin-top: 24px;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
    }
    header.hero {
      display: grid;
      gap: 12px;
      padding-bottom: 28px;
      border-bottom: 1px solid var(--line);
    }
    .summary, .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
    }
    .summary {
      margin-top: 20px;
    }
    .summary div, .grid div, .task {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
    }
    .summary div, .grid div {
      padding: 14px;
    }
    strong {
      display: block;
      font-size: 12px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .summary span, .grid span {
      display: block;
      margin-top: 4px;
      font-size: 20px;
      font-weight: 700;
    }
    .task {
      margin-top: 24px;
      padding: 20px;
    }
    .task header {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 16px;
    }
    ul {
      list-style: none;
      padding: 0;
      margin: 8px 0 0;
      display: grid;
      gap: 8px;
    }
    li {
      border: 1px solid var(--line);
      border-left-width: 4px;
      border-radius: 6px;
      padding: 10px 12px;
      background: #fbfcfa;
    }
    li.pass {
      border-left-color: var(--pass);
    }
    li.fail {
      border-left-color: var(--fail);
    }
    li span {
      display: block;
      margin-top: 2px;
    }
    pre {
      overflow: auto;
      padding: 12px;
      background: #101410;
      color: #edf2ea;
      border-radius: 6px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    details {
      margin-top: 12px;
    }
    summary {
      cursor: pointer;
      color: var(--muted);
      font-weight: 700;
    }
  </style>
</head>
<body>
  <main>
    <header class="hero">
      <h1>Ariadne Reliability Report</h1>
      <p>Run started ${escapeHtml(run.startedAt)} from ${escapeHtml(run.cwd)}</p>
      <div class="summary">
        <div><strong>Tasks</strong><span>${escapeHtml(summaryTotal(run))}</span></div>
        <div><strong>Status</strong><span>${escapeHtml(runStatus(run))}</span></div>
        <div><strong>Passed</strong><span>${escapeHtml(summaryPassed(run))}</span></div>
        <div><strong>Failed</strong><span>${escapeHtml(summaryFailed(run))}</span></div>
        <div><strong>Duration</strong><span>${escapeHtml(formatDuration(run.durationMs))}</span></div>
        <div><strong>Run schema</strong><span>${escapeHtml(getRunSchemaVersion(run))}</span></div>
      </div>
    </header>
    ${results.map((result) => renderTask(result)).join("\n")}
  </main>
</body>
</html>`;
}
