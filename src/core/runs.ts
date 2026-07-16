import path from "node:path";
import fs from "fs-extra";
import { atomicWriteFile } from "./atomic.js";
import { AriadneError } from "./errors.js";
import { buildReportModel } from "./report.js";
import { loadRunHistory } from "./run-reader.js";
import { canonicalizePath, isPathInside } from "./path-containment.js";
import { loadPromotions } from "./promotion.js";

export interface RunListEntry {
  startedAt: string;
  started: string;
  status: string;
  outcome: string;
  taskId: string;
  taskName: string;
  durationMs: number;
  duration: string;
  path: string;
  runId: string;
  score: number | null;
  violations: number;
  batchId?: string;
  attempt?: number;
  promotion: "unapplied" | "applied" | "discarded" | "not-applicable";
}

function formatDuration(value: number): string {
  if (value < 1000) return `${value}ms`;
  const seconds = Math.round(value / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatTasks(values: string[]): string {
  return values.length === 0 ? "none" : values.length === 1 ? values[0] : `${values[0]} +${values.length - 1} more`;
}

export async function listRuns(cwd: string, promotionFilter?: "unapplied" | "applied" | "discarded"): Promise<{ runs: RunListEntry[]; warnings: string[] }> {
  const projectRoot = await fs.realpath(cwd).catch(() => path.resolve(cwd));
  const history = await loadRunHistory(projectRoot);
  const promotions = await loadPromotions(projectRoot);
  const promotionRecords = promotions.flatMap((item) => item.record ? [item.record] : []);
  const runs = history.records.flatMap((loaded): RunListEntry[] => {
    if (!loaded.ok) return [];
    const model = buildReportModel(loaded.run, loaded.warnings, loaded.path);
    const scores = model.tasks.map((task) => task.score);
    const workflow = "runId" in loaded.run ? loaded.run.workflow : undefined;
    const applicable = "runId" in loaded.run && loaded.run.changeArtifact?.applicable === true;
    const promotion: RunListEntry["promotion"] = !applicable ? "not-applicable"
      : promotionRecords.some((item) => item.kind === "apply" && item.status === "succeeded" && item.includedRunIds.includes(model.runId)) ? "applied"
        : promotionRecords.some((item) => item.kind === "discard" && item.status === "discarded" && item.runId === model.runId) ? "discarded" : "unapplied";
    return [{
      startedAt: model.startedAt,
      started: model.startedAt.slice(0, 16).replace("T", " "),
      status: model.status,
      outcome: model.outcome,
      taskId: formatTasks(model.tasks.map((task) => task.id)),
      taskName: formatTasks(model.tasks.map((task) => task.name)),
      durationMs: model.durationMs,
      duration: formatDuration(model.durationMs),
      path: path.relative(projectRoot, loaded.path).split(path.sep).join("/"),
      runId: model.runId,
      score: scores.length > 0 ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length) : null,
      violations: model.tasks.reduce((sum, task) => sum + task.policies.filter((policy) => policy.outcome === "fail").length, 0),
      promotion,
      ...(workflow ? { batchId: workflow.batchId, attempt: workflow.attempt } : {})
    }];
  }).filter((run) => !promotionFilter || run.promotion === promotionFilter).sort((left, right) => right.startedAt.localeCompare(left.startedAt) || right.path.localeCompare(left.path));
  return { runs, warnings: [...history.warnings, ...promotions.flatMap((item) => item.warning ? [item.warning] : [])] };
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "Ariadne runs\n\nNo valid runs found. Run \"ariadne run\" first.";
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index].length)));
  const line = (row: string[]) => row.map((value, index) => index === row.length - 1 ? value : value.padEnd(widths[index])).join("  ");
  return ["Ariadne runs", "", line(headers), ...rows.map(line)].join("\n");
}

export function formatCompactRunList(runs: RunListEntry[]): string {
  return table(["Started", "Status", "Task ID", "Attempt", "Score", "Run ID"], runs.map((run) => [run.started, run.status, run.taskId, run.attempt === undefined ? "—" : String(run.attempt), run.score === null ? "n/a" : String(run.score), run.runId]));
}

export function formatWideRunList(runs: RunListEntry[]): string {
  return table(["Started", "Outcome", "Task Name", "Batch", "Duration", "Violations", "Path"], runs.map((run) => [run.started, run.outcome, run.taskName, run.batchId ?? "standalone", run.duration, String(run.violations), run.path]));
}

function rows(runs: RunListEntry[]): Array<Record<string, string | number | null>> {
  return runs.map((run) => ({ started_at: run.startedAt, status: run.status, outcome: run.outcome, task_id: run.taskId, task_name: run.taskName, batch_id: run.batchId ?? null, attempt: run.attempt ?? null, duration_ms: run.durationMs, score: run.score, violations: run.violations, promotion: run.promotion, run_id: run.runId, path: run.path }));
}

function escapeCsv(value: unknown): string {
  const raw = value === null ? "" : String(value);
  const text = /^[\t\r ]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

export function formatRunCsv(runs: RunListEntry[]): string {
  const headers = ["started_at", "status", "outcome", "task_id", "task_name", "batch_id", "attempt", "duration_ms", "score", "violations", "promotion", "run_id", "path"];
  return `${[headers, ...rows(runs).map((row) => headers.map((header) => row[header]))].map((row) => row.map(escapeCsv).join(",")).join("\n")}\n`;
}

function escapeMarkdown(value: unknown): string {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

export function formatRunMarkdown(runs: RunListEntry[]): string {
  const headers = ["started_at", "status", "outcome", "task_id", "task_name", "batch_id", "attempt", "duration_ms", "score", "violations", "promotion", "run_id", "path"];
  return [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`, ...rows(runs).map((row) => `| ${headers.map((header) => escapeMarkdown(row[header])).join(" | ")} |`), ""].join("\n");
}

export function formatRunJson(runs: RunListEntry[]): string {
  return `${JSON.stringify(rows(runs), null, 2)}\n`;
}

export async function writeRunOutput(cwd: string, outputPath: string, contents: string): Promise<string> {
  const projectRoot = await fs.realpath(cwd).catch(() => path.resolve(cwd));
  const resolved = path.resolve(projectRoot, outputPath);
  if (!isPathInside(projectRoot, await canonicalizePath(resolved))) {
    throw new AriadneError({
      category: "configuration",
      code: "OUTPUT_PATH_OUTSIDE_ROOT",
      stage: "validated",
      message: "Output path must stay inside the project root.",
      fieldPath: "output",
      offendingValue: outputPath,
      expected: "A project-relative output path without traversal or escaping symlinks.",
      correction: "Choose an output path inside the invocation root."
    });
  }
  await atomicWriteFile(resolved, contents);
  return resolved;
}
