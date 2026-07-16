import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import fs from "fs-extra";
import { atomicWriteJson } from "./atomic.js";
import { AriadneError } from "./errors.js";
import { BatchRecordSchema } from "../schema/batch-record.js";
import { CURRENT_BATCH_SCHEMA_VERSION, type BatchPaths, type BatchRecord } from "../types/index.js";

function timestamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

export function createBatchId(date = new Date(), random: string = crypto.randomUUID()): string {
  return `${timestamp(date)}-${random.replace(/-/g, "").slice(0, 10)}`;
}

export async function createBatchPaths(projectRoot: string, batchId: string): Promise<BatchPaths> {
  const batchesDirectory = path.join(projectRoot, ".ariadne", "batches");
  const batchDirectory = path.join(batchesDirectory, batchId);
  await fs.ensureDir(batchesDirectory);
  try {
    await mkdir(batchDirectory, { recursive: false, mode: 0o700 });
  } catch (error) {
    throw new AriadneError({
      category: "persistence", code: "BATCH_ID_COLLISION", stage: "preparing", source: batchDirectory,
      message: `Batch directory already exists or could not be created: ${batchDirectory}.`, correction: "Retry so Ariadne generates a new batch ID.", cause: error
    });
  }
  const manifestPath = path.join(batchDirectory, "batch.json");
  return {
    batchesDirectory,
    batchDirectory,
    manifestPath,
    relativeManifestPath: path.relative(projectRoot, manifestPath).split(path.sep).join("/"),
    latestPointerPath: path.join(batchesDirectory, "latest.json"),
    latestInvocationPath: path.join(projectRoot, ".ariadne", "latest.json")
  };
}

export function initialBatchRecord(options: { batchId: string; startedAt: Date; ariadneVersion: string; paths: BatchPaths }): BatchRecord {
  const startedAt = options.startedAt.toISOString();
  return {
    schemaVersion: CURRENT_BATCH_SCHEMA_VERSION,
    kind: "batch",
    runId: options.batchId,
    batchId: options.batchId,
    status: "running",
    batchStatus: "running",
    outcome: "passed",
    startedAt,
    updatedAt: startedAt,
    ariadneVersion: options.ariadneVersion,
    environment: { node: process.version, platform: process.platform, release: os.release(), arch: process.arch },
    owner: { pid: process.pid, hostname: os.hostname(), startedAt },
    project: { root: "." },
    tasks: [],
    lifecycle: [{ stage: "created", at: startedAt }],
    failures: [],
    warnings: [],
    summary: { total: 0, succeeded: 0, failed: 0, blocked: 0, skipped: 0, interrupted: 0, incomplete: 0, retried: 0, score: null, status: "running", outcome: "passed" },
    artifacts: { manifest: options.paths.relativeManifestPath }
  };
}

export async function persistBatch(record: BatchRecord, paths: BatchPaths): Promise<void> {
  record.updatedAt = new Date().toISOString();
  const parsed = BatchRecordSchema.safeParse(record);
  if (!parsed.success) {
    throw new AriadneError({
      category: "persistence", code: "BATCH_RECORD_INVALID", stage: "persisting", source: paths.manifestPath,
      message: `Refusing to persist an invalid batch record: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
      details: { issues: parsed.error.issues }
    });
  }
  await atomicWriteJson(paths.manifestPath, parsed.data);
}

export async function updateBatchPointers(record: BatchRecord, paths: BatchPaths): Promise<void> {
  if (record.status === "running") return;
  const pointer = { schemaVersion: 1, kind: "batch", batchId: record.batchId, manifest: `${record.batchId}/batch.json`, status: record.status, batchStatus: record.batchStatus, outcome: record.outcome, updatedAt: record.updatedAt };
  await atomicWriteJson(paths.latestPointerPath, pointer);
  await atomicWriteJson(paths.latestInvocationPath, { ...pointer, manifest: `.ariadne/batches/${record.batchId}/batch.json` });
}
