import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import fs from "fs-extra";
import { atomicWriteJson } from "./atomic.js";
import { AriadneError } from "./errors.js";
import { RunRecordSchema } from "../schema/run-record.js";
import { CURRENT_RUN_SCHEMA_VERSION, type RunPaths, type RunRecord, type TaskOutcome } from "../types/index.js";

function formatRunTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "").replace("Z", "Z");
}

export function createRunId(date = new Date(), random: string = crypto.randomUUID()): string {
  return `${formatRunTimestamp(date)}-${random.replace(/-/g, "").slice(0, 10)}`;
}

export async function createRunPaths(projectRoot: string, runId: string): Promise<RunPaths> {
  const runsDirectory = path.join(projectRoot, ".ariadne", "runs");
  const runDirectory = path.join(runsDirectory, runId);
  await fs.ensureDir(runsDirectory);
  try {
    await mkdir(runDirectory, { recursive: false, mode: 0o700 });
  } catch (error) {
    throw new AriadneError({
      category: "persistence",
      code: "RUN_ID_COLLISION",
      stage: "preparing",
      source: runDirectory,
      message: `Run directory already exists or could not be created: ${runDirectory}.`,
      correction: "Retry the run so Ariadne generates a new collision-resistant run ID.",
      cause: error
    });
  }
  await fs.ensureDir(path.join(runDirectory, "artifacts"));
  return {
    runsDirectory,
    runDirectory,
    manifestPath: path.join(runDirectory, "run.json"),
    relativeManifestPath: path.relative(projectRoot, path.join(runDirectory, "run.json")).split(path.sep).join("/"),
    latestPointerPath: path.join(runsDirectory, "latest.json")
  };
}

export function initialRunRecord(options: {
  runId: string;
  startedAt: Date;
  ariadneVersion: string;
  paths: RunPaths;
}): RunRecord {
  const startedAt = options.startedAt.toISOString();
  return {
    schemaVersion: CURRENT_RUN_SCHEMA_VERSION,
    runId: options.runId,
    status: "running",
    startedAt,
    updatedAt: startedAt,
    ariadneVersion: options.ariadneVersion,
    environment: {
      node: process.version,
      platform: process.platform,
      release: os.release(),
      arch: process.arch
    },
    owner: { pid: process.pid, hostname: os.hostname(), startedAt },
    project: { root: "." },
    compatibilityWarnings: [],
    lifecycle: [{ stage: "created", at: startedAt }],
    results: [],
    summary: { total: 0, passed: 0, failed: 0, interrupted: 0, status: "running", outcome: "passed" },
    failures: [],
    artifacts: { manifest: options.paths.relativeManifestPath }
  };
}

export async function persistRun(record: RunRecord, paths: RunPaths): Promise<void> {
  record.updatedAt = new Date().toISOString();
  const parsed = RunRecordSchema.safeParse(record);
  if (!parsed.success) {
    throw new AriadneError({
      category: "persistence",
      code: "RUN_RECORD_INVALID",
      stage: "persisting",
      source: paths.manifestPath,
      message: `Refusing to persist an invalid run record: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
      details: { issues: parsed.error.issues }
    });
  }
  await atomicWriteJson(paths.manifestPath, parsed.data);
}

export async function updateLatestPointer(record: RunRecord, paths: RunPaths): Promise<void> {
  if (record.status === "running") return;
  await atomicWriteJson(paths.latestPointerPath, {
    schemaVersion: 1,
    runId: record.runId,
    manifest: `${record.runId}/run.json`,
    status: record.status,
    updatedAt: record.updatedAt
  });
}

export function summarizeOutcome(outcomes: TaskOutcome[]): TaskOutcome {
  const precedence: TaskOutcome[] = ["interrupted", "internal_failed", "preparation_failed", "timeout", "agent_failed", "verification_failed", "policy_failed", "passed"];
  return precedence.find((candidate) => outcomes.includes(candidate)) ?? "passed";
}
