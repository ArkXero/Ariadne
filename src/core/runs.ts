import path from "node:path";
import fs from "fs-extra";
import type { AriadneRun, TaskScoreStatus } from "../types/index.js";

export interface RunListEntry {
  started: string;
  status: TaskScoreStatus;
  task: string;
  duration: string;
  path: string;
}

function runStatus(run: AriadneRun): TaskScoreStatus {
  return run.summary.status ?? (run.summary.failed > 0 ? "check_failed" : "passed");
}

function formatStarted(startedAt: string): string {
  return startedAt.slice(0, 16).replace("T", " ");
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

function formatTask(run: AriadneRun): string {
  const names = run.results.map((result) => result.task.name);

  if (names.length === 0) {
    return "none";
  }

  if (names.length === 1) {
    return names[0];
  }

  return `${names[0]} +${names.length - 1} more`;
}

export async function listRuns(cwd: string): Promise<RunListEntry[]> {
  const runsDir = path.join(cwd, ".ariadne", "runs");

  if (!(await fs.pathExists(runsDir))) {
    throw new Error(`Runs directory not found: ${runsDir}. Run "ariadne init" first.`);
  }

  const files = (await fs.readdir(runsDir))
    .filter((file) => file.endsWith(".json"));
  const runs = await Promise.all(files.map(async (file) => {
    const runPath = path.join(runsDir, file);
    const run = await fs.readJson(runPath) as AriadneRun;

    return {
      run,
      path: path.relative(cwd, runPath)
    };
  }));

  return runs
    .sort((left, right) => right.run.startedAt.localeCompare(left.run.startedAt))
    .map(({ run, path: runPath }) => ({
      started: formatStarted(run.startedAt),
      status: runStatus(run),
      task: formatTask(run),
      duration: formatDuration(run.durationMs),
      path: runPath
    }));
}

export function formatRunList(runs: RunListEntry[]): string {
  if (runs.length === 0) {
    return "Ariadne runs\n\nNo runs found. Run \"ariadne run\" first.";
  }

  const headers = ["Started", "Status", "Task", "Duration", "Path"] as const;
  const rows = runs.map((run) => [
    run.started,
    run.status,
    run.task,
    run.duration,
    run.path
  ]);
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

function escapeCsv(value: string): string {
  if (!/[",\r\n]/.test(value)) {
    return value;
  }

  return `"${value.replace(/"/g, "\"\"")}"`;
}

export function formatRunCsv(runs: RunListEntry[]): string {
  const rows = [
    ["Started", "Status", "Task", "Duration", "Path"],
    ...runs.map((run) => [
      run.started,
      run.status,
      run.task,
      run.duration,
      run.path
    ])
  ];

  return `${rows.map((row) => row.map(escapeCsv).join(",")).join("\n")}\n`;
}

export async function writeRunCsv(cwd: string, csvPath: string, runs: RunListEntry[]): Promise<string> {
  const resolvedPath = path.resolve(cwd, csvPath);
  await fs.outputFile(resolvedPath, formatRunCsv(runs));
  return resolvedPath;
}
