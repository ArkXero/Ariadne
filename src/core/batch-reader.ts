import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { BatchRecordSchema } from "../schema/batch-record.js";
import { CURRENT_BATCH_SCHEMA_VERSION, type BatchRecord } from "../types/index.js";
import { AriadneError } from "./errors.js";
import { canonicalizePath, isPathInside } from "./path-containment.js";

export type BatchLoadResult =
  | { ok: true; path: string; batch: BatchRecord; warnings: string[] }
  | { ok: false; path: string; code: "malformed" | "unsupported-version" | "missing"; error: string };

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return error instanceof Error && "code" in error && error.code === "EPERM"; }
}

function abandoned(batch: BatchRecord, warnings: string[]): BatchRecord {
  if (batch.status !== "running" || batch.owner.hostname !== os.hostname() || processIsAlive(batch.owner.pid)) return batch;
  warnings.push(`Batch ${batch.batchId} is marked running, but owner PID ${batch.owner.pid} is no longer alive on this host; displayed as abandoned.`);
  return { ...batch, status: "abandoned", batchStatus: "abandoned", outcome: "internal_failed", summary: { ...batch.summary, status: "abandoned", outcome: "internal_failed" } };
}

function adaptV1Batch(value: unknown): unknown {
  const adapted = structuredClone(value) as Record<string, any>;
  adapted.schemaVersion = CURRENT_BATCH_SCHEMA_VERSION;
  if (adapted.plan) {
    adapted.plan.schemaVersion = 2;
    adapted.plan.isolation = "shared";
    adapted.plan.retention = "on-failure";
    adapted.plan.dirtyBaseAcknowledged = false;
    for (const task of adapted.plan.tasks ?? []) {
      task.workspaceMode = task.parallelSafe ? "read-only" : "mutable";
      delete task.parallelSafe;
    }
  }
  for (const task of adapted.tasks ?? []) {
    task.workspaceMode = task.parallelSafe ? "read-only" : "mutable";
    delete task.parallelSafe;
  }
  return adapted;
}

export async function loadBatchFile(filePath: string, cwd?: string): Promise<BatchLoadResult> {
  if (!(await fs.pathExists(filePath))) return { ok: false, path: filePath, code: "missing", error: `Batch record not found: ${filePath}` };
  let raw: unknown;
  try { raw = await fs.readJson(filePath); } catch (error) {
    return { ok: false, path: filePath, code: "malformed", error: `Could not parse batch JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const version = raw && typeof raw === "object" ? (raw as Record<string, unknown>).schemaVersion : undefined;
  if (typeof version === "number" && version > CURRENT_BATCH_SCHEMA_VERSION) return { ok: false, path: filePath, code: "unsupported-version", error: `Batch record version ${version} is newer than supported version ${CURRENT_BATCH_SCHEMA_VERSION}.` };
  const parsed = BatchRecordSchema.safeParse(version === 1 ? adaptV1Batch(raw) : raw);
  if (!parsed.success) return { ok: false, path: filePath, code: "malformed", error: `Invalid batch record: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}` };
  const warnings: string[] = version === 1 ? ["Batch record version 1 predates isolated workspace and promotion metadata."] : [];
  const projectRoot = cwd
    ? await canonicalizePath(cwd)
    : path.dirname(path.dirname(path.dirname(path.dirname(await canonicalizePath(filePath)))));
  for (const task of parsed.data.tasks) {
    for (const attempt of task.attempts) {
      const candidate = path.resolve(projectRoot, attempt.manifest);
      const resolved = await canonicalizePath(candidate);
      if (!isPathInside(projectRoot, resolved)) warnings.push(`Batch ${parsed.data.batchId} references child run ${attempt.runId} outside the project root: ${attempt.manifest}`);
      else if (!(await fs.pathExists(candidate))) warnings.push(`Batch ${parsed.data.batchId} is missing child run ${attempt.runId}: ${attempt.manifest}`);
    }
  }
  const batch = { ...parsed.data, schemaVersion: version === 1 ? 1 as const : CURRENT_BATCH_SCHEMA_VERSION } as BatchRecord;
  return { ok: true, path: filePath, batch: abandoned(batch, warnings), warnings };
}

export async function discoverBatchFiles(cwd: string): Promise<string[]> {
  const root = await fs.realpath(cwd).catch(() => path.resolve(cwd));
  const directory = path.join(root, ".ariadne", "batches");
  if (!(await fs.pathExists(directory))) return [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) if (entry.isDirectory() && await fs.pathExists(path.join(directory, entry.name, "batch.json"))) files.push(path.join(directory, entry.name, "batch.json"));
  return files.sort();
}

export async function loadBatchHistory(cwd: string): Promise<{ records: BatchLoadResult[]; warnings: string[] }> {
  const root = await fs.realpath(cwd).catch(() => path.resolve(cwd));
  const records = await Promise.all((await discoverBatchFiles(root)).map((file) => loadBatchFile(file, root)));
  const warnings = records.flatMap((record) => record.ok ? record.warnings.map((warning) => `${path.relative(root, record.path)}: ${warning}`) : [`${path.relative(root, record.path)}: ${record.error}`]);
  return { records, warnings };
}

export async function resolveBatchFile(cwd: string, idOrPath?: string): Promise<string> {
  const root = await fs.realpath(cwd).catch(() => path.resolve(cwd));
  if (idOrPath) {
    const candidate = idOrPath.includes("/") || idOrPath.includes("\\") || idOrPath.endsWith(".json")
      ? path.resolve(root, idOrPath)
      : path.join(root, ".ariadne", "batches", idOrPath, "batch.json");
    const resolved = await canonicalizePath(candidate);
    if (!isPathInside(root, resolved)) {
      throw new AriadneError({
        category: "configuration",
        code: "BATCH_PATH_OUTSIDE_ROOT",
        stage: "validated",
        message: "Batch record path must stay inside the project root.",
        fieldPath: "batch",
        offendingValue: idOrPath,
        expected: "A batch ID or project-relative path without traversal.",
        correction: "Choose a batch record inside the invocation root."
      });
    }
    return candidate;
  }
  const pointerPath = path.join(root, ".ariadne", "batches", "latest.json");
  if (await fs.pathExists(pointerPath)) {
    try {
      const pointer = await fs.readJson(pointerPath) as { manifest?: unknown };
      if (typeof pointer.manifest === "string") {
        const candidate = path.resolve(path.dirname(pointerPath), pointer.manifest);
        if (isPathInside(path.dirname(pointerPath), await canonicalizePath(candidate)) && await fs.pathExists(candidate)) return candidate;
      }
    } catch { /* deterministic fallback */ }
  }
  const valid = (await loadBatchHistory(root)).records.filter((record): record is Extract<BatchLoadResult, { ok: true }> => record.ok)
    .sort((left, right) => right.batch.startedAt.localeCompare(left.batch.startedAt) || right.path.localeCompare(left.path));
  if (!valid[0]) throw new Error(`No valid batch records found in ${path.join(root, ".ariadne", "batches")}. Run "ariadne run" first.`);
  return valid[0].path;
}
