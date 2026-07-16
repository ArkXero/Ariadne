import path from "node:path";
import fs from "fs-extra";
import { loadBatchHistory } from "./batch-reader.js";

export interface BatchListEntry {
  startedAt: string;
  started: string;
  status: string;
  outcome: string;
  selectedRoots: string;
  total: number;
  succeeded: number;
  failed: number;
  blocked: number;
  retried: number;
  durationMs: number;
  duration: string;
  score: number | null;
  relation: string;
  batchId: string;
  path: string;
}

function duration(value: number): string {
  if (value < 1000) return `${value}ms`;
  const seconds = Math.round(value / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export async function listBatches(cwd: string): Promise<{ batches: BatchListEntry[]; warnings: string[] }> {
  const root = await fs.realpath(cwd).catch(() => path.resolve(cwd));
  const history = await loadBatchHistory(root);
  const batches = history.records.flatMap((loaded): BatchListEntry[] => loaded.ok ? [{
    startedAt: loaded.batch.startedAt,
    started: loaded.batch.startedAt.slice(0, 16).replace("T", " "),
    status: loaded.batch.batchStatus,
    outcome: loaded.batch.summary.outcome,
    selectedRoots: loaded.batch.plan?.selectedRoots.join(", ") ?? "none",
    total: loaded.batch.summary.total,
    succeeded: loaded.batch.summary.succeeded,
    failed: loaded.batch.summary.failed,
    blocked: loaded.batch.summary.blocked,
    retried: loaded.batch.summary.retried,
    durationMs: loaded.batch.durationMs ?? 0,
    duration: duration(loaded.batch.durationMs ?? 0),
    score: loaded.batch.summary.score,
    relation: loaded.batch.relation ? `${loaded.batch.relation.kind}:${loaded.batch.relation.sourceBatchId}` : "original",
    batchId: loaded.batch.batchId,
    path: path.relative(root, loaded.path).split(path.sep).join("/")
  }] : []).sort((left, right) => right.startedAt.localeCompare(left.startedAt) || right.path.localeCompare(left.path));
  return { batches, warnings: history.warnings };
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "Ariadne batches\n\nNo valid batches found. Run \"ariadne run\" first.";
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index].length)));
  const line = (row: string[]) => row.map((value, index) => index === row.length - 1 ? value : value.padEnd(widths[index])).join("  ");
  return ["Ariadne batches", "", line(headers), ...rows.map(line)].join("\n");
}

export function formatCompactBatchList(values: BatchListEntry[]): string {
  return table(["Started", "Status", "Tasks", "Score", "Batch ID"], values.map((batch) => [batch.started, batch.status, String(batch.total), batch.score === null ? "n/a" : String(batch.score), batch.batchId]));
}

export function formatWideBatchList(values: BatchListEntry[]): string {
  return table(["Started", "Outcome", "Roots", "Passed/Failed/Blocked", "Retries", "Duration", "Path"], values.map((batch) => [batch.started, batch.outcome, batch.selectedRoots, `${batch.succeeded}/${batch.failed}/${batch.blocked}`, String(batch.retried), batch.duration, batch.path]));
}

function rows(values: BatchListEntry[]): Array<Record<string, string | number | null>> {
  return values.map((batch) => ({ started_at: batch.startedAt, status: batch.status, outcome: batch.outcome, selected_roots: batch.selectedRoots, total: batch.total, succeeded: batch.succeeded, failed: batch.failed, blocked: batch.blocked, retried: batch.retried, duration_ms: batch.durationMs, score: batch.score, relation: batch.relation, batch_id: batch.batchId, path: batch.path }));
}

function csv(value: unknown): string {
  const raw = value === null ? "" : String(value);
  const safe = /^[\t\r ]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, "\"\"")}"` : safe;
}

const headers = ["started_at", "status", "outcome", "selected_roots", "total", "succeeded", "failed", "blocked", "retried", "duration_ms", "score", "relation", "batch_id", "path"];

export function formatBatchCsv(values: BatchListEntry[]): string {
  return `${[headers, ...rows(values).map((row) => headers.map((header) => row[header]))].map((row) => row.map(csv).join(",")).join("\n")}\n`;
}

export function formatBatchMarkdown(values: BatchListEntry[]): string {
  const escape = (value: unknown) => String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
  return [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`, ...rows(values).map((row) => `| ${headers.map((header) => escape(row[header])).join(" | ")} |`), ""].join("\n");
}

export function formatBatchJson(values: BatchListEntry[]): string {
  return `${JSON.stringify(rows(values), null, 2)}\n`;
}
