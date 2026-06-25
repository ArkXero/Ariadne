import path from "node:path";
import fs from "fs-extra";
import type { AriadneRun, TaskScoreStatus } from "../types/index.js";

export interface RunListEntry {
  startedAt: string;
  started: string;
  status: TaskScoreStatus;
  taskId: string;
  taskName: string;
  durationMs: number;
  duration: string;
  path: string;
  runId: string;
}

function runStatus(run: AriadneRun): TaskScoreStatus {
  const failed = run.summary?.failed ?? (run.results ?? []).filter((result) => !result.score?.passed).length;
  return run.summary?.status ?? (failed > 0 ? "check_failed" : "passed");
}

function formatStarted(startedAt: string): string {
  return startedAt ? startedAt.slice(0, 16).replace("T", " ") : "unknown";
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds}s`;
}

function formatTasks(values: string[]): string {
  if (values.length === 0) {
    return "none";
  }

  if (values.length === 1) {
    return values[0];
  }

  return `${values[0]} +${values.length - 1} more`;
}

function formatTable(headers: readonly string[], rows: string[][]): string {
  const widths = headers.map((header, index) => Math.max(
    header.length,
    ...rows.map((row) => row[index].length)
  ));
  const formatRow = (row: readonly string[]) => row
    .map((value, index) => index === row.length - 1 ? value : value.padEnd(widths[index]))
    .join("  ");

  return [
    "Ariadne runs",
    "",
    formatRow(headers),
    ...rows.map(formatRow)
  ].join("\n");
}

function exportRows(runs: RunListEntry[]): Array<Record<string, string | number>> {
  return runs.map((run) => ({
    started_at: run.startedAt,
    status: run.status,
    task_id: run.taskId,
    task_name: run.taskName,
    duration_ms: run.durationMs,
    duration: run.duration,
    path: run.path
  }));
}

export async function listRuns(cwd: string): Promise<RunListEntry[]> {
  const runsDir = path.join(cwd, ".ariadne", "runs");

  if (!(await fs.pathExists(runsDir))) {
    throw new Error(`Runs directory not found: ${runsDir}. Run "ariadne init" first.`);
  }

  const files = (await fs.readdir(runsDir))
    .filter((file) => file.endsWith(".json") && file !== "runs.json");
  const runs = await Promise.all(files.map(async (file) => {
    const runPath = path.join(runsDir, file);
    const run = await fs.readJson(runPath) as AriadneRun;

    return {
      run,
      path: path.relative(cwd, runPath)
    };
  }));

  return runs
    .sort((left, right) => {
      const startedOrder = (right.run.startedAt ?? "").localeCompare(left.run.startedAt ?? "");
      return startedOrder === 0 ? right.path.localeCompare(left.path) : startedOrder;
    })
    .map(({ run, path: runPath }) => ({
      startedAt: run.startedAt ?? "",
      started: formatStarted(run.startedAt ?? ""),
      status: runStatus(run),
      taskId: formatTasks((run.results ?? []).map((result) => result.task.id)),
      taskName: formatTasks((run.results ?? []).map((result) => result.task.name)),
      durationMs: run.durationMs ?? 0,
      duration: formatDuration(run.durationMs ?? 0),
      path: runPath,
      runId: path.basename(runPath, ".json")
    }));
}

function emptyRunList(): string {
  return "Ariadne runs\n\nNo runs found. Run \"ariadne run\" first.";
}

export function formatCompactRunList(runs: RunListEntry[]): string {
  if (runs.length === 0) {
    return emptyRunList();
  }

  return formatTable(["Started", "Status", "Task ID", "Duration", "Run ID"], runs.map((run) => [
    run.started,
    run.status,
    run.taskId,
    run.duration,
    run.runId
  ]));
}

export function formatWideRunList(runs: RunListEntry[]): string {
  if (runs.length === 0) {
    return emptyRunList();
  }

  return formatTable(["Started", "Status", "Task Name", "Duration", "Path"], runs.map((run) => [
    run.started,
    run.status,
    run.taskName,
    run.duration,
    run.path
  ]));
}

function escapeCsv(value: string): string {
  if (!/[",\r\n]/.test(value)) {
    return value;
  }

  return `"${value.replace(/"/g, "\"\"")}"`;
}

export function formatRunCsv(runs: RunListEntry[]): string {
  const headers = ["started_at", "status", "task_id", "task_name", "duration_ms", "duration", "path"];
  const rows = [
    headers,
    ...exportRows(runs).map((row) => headers.map((header) => String(row[header])))
  ];

  return `${rows.map((row) => row.map(escapeCsv).join(",")).join("\n")}\n`;
}

function escapeMarkdown(value: string | number): string {
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

export function formatRunMarkdown(runs: RunListEntry[]): string {
  const headers = ["started_at", "status", "task_id", "task_name", "duration_ms", "duration", "path"];
  const rows = exportRows(runs);

  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${headers.map((header) => escapeMarkdown(row[header])).join(" | ")} |`),
    ""
  ].join("\n");
}

export function formatRunJson(runs: RunListEntry[]): string {
  return `${JSON.stringify(exportRows(runs), null, 2)}\n`;
}

async function writeRunExport(cwd: string, outputPath: string, contents: string): Promise<string> {
  const resolvedPath = path.resolve(cwd, outputPath);
  await fs.outputFile(resolvedPath, contents);
  return resolvedPath;
}

export async function writeRunCsv(cwd: string, runs: RunListEntry[]): Promise<string> {
  return writeRunExport(cwd, ".ariadne/runs/runs.csv", formatRunCsv(runs));
}

export async function writeRunMarkdown(cwd: string, runs: RunListEntry[]): Promise<string> {
  return writeRunExport(cwd, ".ariadne/runs/runs.md", formatRunMarkdown(runs));
}

export async function writeRunJson(cwd: string, runs: RunListEntry[]): Promise<string> {
  return writeRunExport(cwd, ".ariadne/runs/runs.json", formatRunJson(runs));
}
