import path from "node:path";
import fs from "fs-extra";
import type { AriadneRun, ScoreCheck, TaskRunResult } from "../types/index.js";

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function statusLabel(passed: boolean): string {
  return passed ? "PASS" : "FAIL";
}

function formatCheck(check: ScoreCheck): string {
  return `${statusLabel(check.passed)} ${check.name}: ${check.message}`;
}

export async function findLatestRunFile(cwd: string): Promise<string> {
  const runsDir = path.join(cwd, ".ariadne", "runs");

  if (!(await fs.pathExists(runsDir))) {
    throw new Error(`Runs directory not found: ${runsDir}. Run "ariadne run" first.`);
  }

  const files = (await fs.readdir(runsDir))
    .filter((file) => file.endsWith(".json"))
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

export function formatTerminalSummary(run: AriadneRun): string {
  const lines = [
    `Ariadne run: ${run.startedAt}`,
    `Duration: ${run.durationMs}ms`,
    `Tasks: ${run.summary.total}, passed: ${run.summary.passed}, failed: ${run.summary.failed}`,
    ""
  ];

  for (const result of run.results) {
    lines.push(`${statusLabel(result.score.passed)} ${result.task.id} - ${result.task.name}`);
    lines.push(`  Agent exit: ${result.agent.exitCode}, runtime: ${result.agent.runtimeMs}ms`);
    lines.push(`  Changed files: ${result.trace.changedFiles.length}, diff lines: ${result.trace.diffLineCount}`);
    if (result.trace.forbiddenFileChanges.length > 0) {
      lines.push(`  Forbidden file changes: ${result.trace.forbiddenFileChanges.join(", ")}`);
    }

    const failedChecks = result.score.checks.filter((check) => !check.passed);
    if (failedChecks.length > 0) {
      for (const check of failedChecks) {
        lines.push(`  ${formatCheck(check)}`);
      }
    }
  }

  return lines.join("\n");
}

function renderChecks(checks: ScoreCheck[]): string {
  return checks.map((check) => {
    const className = check.passed ? "pass" : "fail";
    const details = check.details ? `<pre>${escapeHtml(JSON.stringify(check.details, null, 2))}</pre>` : "";
    return `<li class="${className}"><strong>${escapeHtml(statusLabel(check.passed))} ${escapeHtml(check.name)}</strong><span>${escapeHtml(check.message)}</span>${details}</li>`;
  }).join("");
}

function renderTask(result: TaskRunResult): string {
  return `<section class="task">
  <header>
    <h2>${escapeHtml(statusLabel(result.score.passed))} ${escapeHtml(result.task.id)}</h2>
    <p>${escapeHtml(result.task.name)}</p>
  </header>
  <div class="grid">
    <div><strong>Agent exit</strong><span>${escapeHtml(result.agent.exitCode)}</span></div>
    <div><strong>Agent runtime</strong><span>${escapeHtml(result.agent.runtimeMs)}ms</span></div>
    <div><strong>Changed files</strong><span>${escapeHtml(result.trace.changedFiles.length)}</span></div>
    <div><strong>Diff lines</strong><span>${escapeHtml(result.trace.diffLineCount)}</span></div>
  </div>
  <h3>Checks</h3>
  <ul>${renderChecks(result.score.checks)}</ul>
  <h3>Changed files</h3>
  <pre>${escapeHtml(result.trace.changedFiles.join("\n") || "None")}</pre>
  <h3>Forbidden file changes</h3>
  <pre>${escapeHtml(result.trace.forbiddenFileChanges.join("\n") || "None")}</pre>
  <h3>Commands observed</h3>
  <pre>${escapeHtml(result.trace.commandsObserved.join("\n") || "None")}</pre>
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
    <pre>${escapeHtml(result.trace.diff || "")}</pre>
  </details>
</section>`;
}

export function buildHtmlReport(run: AriadneRun): string {
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
        <div><strong>Tasks</strong><span>${escapeHtml(run.summary.total)}</span></div>
        <div><strong>Passed</strong><span>${escapeHtml(run.summary.passed)}</span></div>
        <div><strong>Failed</strong><span>${escapeHtml(run.summary.failed)}</span></div>
        <div><strong>Duration</strong><span>${escapeHtml(run.durationMs)}ms</span></div>
      </div>
    </header>
    ${run.results.map((result) => renderTask(result)).join("\n")}
  </main>
</body>
</html>`;
}
