import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { RunRecordSchema } from "../schema/run-record.js";
import { CURRENT_RUN_SCHEMA_VERSION, type AnyRunRecord, type LegacyRunRecord, type RunRecord } from "../types/index.js";
import { canonicalizePath, isPathInside } from "./path-containment.js";
import { AriadneError } from "./errors.js";
import { DEFAULT_IO_CONCURRENCY, mapWithConcurrency } from "./bounded-map.js";

export type RunLoadResult =
  | { ok: true; path: string; run: AnyRunRecord; warnings: string[]; legacy: boolean }
  | { ok: false; path: string; code: "malformed" | "unsupported-version" | "missing"; error: string };

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function abandonedView(run: RunRecord, warnings: string[]): RunRecord {
  if (run.status !== "running" || run.owner.hostname !== os.hostname() || processIsAlive(run.owner.pid)) return run;
  warnings.push(`Run ${run.runId} is marked running, but owner PID ${run.owner.pid} is no longer alive on this host; displayed as abandoned.`);
  return {
    ...run,
    status: "abandoned",
    summary: { ...run.summary, status: "abandoned", outcome: "internal_failed" }
  };
}

function isLegacyRun(value: unknown): value is LegacyRunRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.startedAt === "string" && (candidate.results === undefined || Array.isArray(candidate.results));
}

function adaptModernRun(value: unknown, version: 2 | 3 | 4): unknown {
  const adapted = structuredClone(value) as Record<string, any>;
  adapted.schemaVersion = CURRENT_RUN_SCHEMA_VERSION;
  if (adapted.config) {
    adapted.config.version = 5;
    adapted.config.sourceVersion ??= version;
    if (version !== 4) {
      adapted.config.execution = {
        termination_grace_ms: 2_000, concurrency: 1, failure_mode: "continue",
        ...adapted.config.execution,
        isolation: "shared",
        worktree: { retention: "on-failure", preparation: { commands: [], timeout_ms: 600_000 } }
      };
    }
  }
  for (const result of adapted.results ?? []) {
    if (result.trace) {
      result.trace.postPreparation ??= result.trace.baseline;
      result.trace.preparationChanges ??= [];
    }
  }
  return adapted;
}

function projectRootForManifest(runPath: string): string | undefined {
  const runDirectory = path.dirname(runPath);
  const runsDirectory = path.dirname(runDirectory);
  const ariadneDirectory = path.dirname(runsDirectory);
  if (path.basename(runsDirectory) !== "runs" || path.basename(ariadneDirectory) !== ".ariadne") return undefined;
  return path.dirname(ariadneDirectory);
}

function referencedArtifacts(run: RunRecord): string[] {
  const artifacts = new Set<string>();
  for (const result of run.results) {
    if (result.agent) {
      artifacts.add(result.agent.stdoutArtifact);
      artifacts.add(result.agent.stderrArtifact);
    }
    for (const verification of result.verification) {
      if (!verification.command) continue;
      artifacts.add(verification.command.stdoutArtifact);
      artifacts.add(verification.command.stderrArtifact);
    }
    if (result.trace?.diffArtifact) artifacts.add(result.trace.diffArtifact);
    if (result.benchmark?.packet) artifacts.add(result.benchmark.packet.artifact);
    if (result.benchmark?.judge) {
      artifacts.add(result.benchmark.judge.process.stdoutArtifact);
      artifacts.add(result.benchmark.judge.process.stderrArtifact);
    }
  }
  if (run.artifacts.report) artifacts.add(run.artifacts.report);
  return [...artifacts].sort();
}

async function artifactWarnings(run: RunRecord, runPath: string): Promise<string[]> {
  const projectRoot = projectRootForManifest(runPath);
  if (!projectRoot) return [];
  const warnings: string[] = [];
  for (const artifact of referencedArtifacts(run)) {
    const absolute = path.resolve(projectRoot, artifact);
    if (!isPathInside(projectRoot, await canonicalizePath(absolute))) {
      warnings.push(`Run ${run.runId} has an artifact path outside the project root: ${artifact}`);
    } else if (!(await fs.pathExists(absolute))) {
      warnings.push(`Run ${run.runId} is missing artifact: ${artifact}`);
    }
  }
  return warnings;
}

export async function loadRunFile(runPath: string): Promise<RunLoadResult> {
  if (!(await fs.pathExists(runPath))) return { ok: false, path: runPath, code: "missing", error: `Run record not found: ${runPath}` };
  let raw: unknown;
  try {
    raw = await fs.readJson(runPath);
  } catch (error) {
    return { ok: false, path: runPath, code: "malformed", error: `Could not parse run JSON: ${error instanceof Error ? error.message : String(error)}` };
  }

  const version = raw && typeof raw === "object"
    ? ((raw as Record<string, unknown>).schemaVersion ?? (raw as Record<string, unknown>).version)
    : undefined;
  if (typeof version === "number" && version > CURRENT_RUN_SCHEMA_VERSION) {
    return { ok: false, path: runPath, code: "unsupported-version", error: `Run record version ${version} is newer than supported version ${CURRENT_RUN_SCHEMA_VERSION}.` };
  }
  if (version === CURRENT_RUN_SCHEMA_VERSION) {
    const parsed = RunRecordSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, path: runPath, code: "malformed", error: `Invalid run record: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}` };
    }
    const run = { ...parsed.data, schemaVersion: version } as RunRecord;
    const warnings = await artifactWarnings(run, runPath);
    return { ok: true, path: runPath, run: abandonedView(run, warnings), warnings, legacy: false };
  }
  if (version === 2 || version === 3 || version === 4) {
    const parsed = RunRecordSchema.safeParse(adaptModernRun(raw, version));
    if (!parsed.success) return { ok: false, path: runPath, code: "malformed", error: `Invalid v${version} run record: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}` };
    const run = { ...parsed.data, schemaVersion: version } as RunRecord;
    const warnings = [`Run record version ${version} predates professional benchmark scoring metadata.`, ...await artifactWarnings(run, runPath)];
    return { ok: true, path: runPath, run: abandonedView(run, warnings), warnings, legacy: false };
  }
  if (version === undefined || version === 1) {
    if (!isLegacyRun(raw)) return { ok: false, path: runPath, code: "malformed", error: "Legacy run record is missing a valid startedAt or results field." };
    return { ok: true, path: runPath, run: raw, warnings: ["Legacy run-record attribution and lifecycle details are unavailable."], legacy: true };
  }
  return { ok: false, path: runPath, code: "unsupported-version", error: `Run record version ${String(version)} is unsupported.` };
}

export async function discoverRunFiles(cwd: string): Promise<string[]> {
  const projectRoot = await fs.realpath(cwd).catch(() => path.resolve(cwd));
  const runsDirectory = path.join(projectRoot, ".ariadne", "runs");
  if (!(await fs.pathExists(runsDirectory))) return [];
  const entries = await fs.readdir(runsDirectory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const manifest = path.join(runsDirectory, entry.name, "run.json");
      if (await fs.pathExists(manifest)) files.push(manifest);
    } else if (entry.isFile() && entry.name.endsWith(".json") && !["runs.json", "latest.json"].includes(entry.name)) {
      files.push(path.join(runsDirectory, entry.name));
    }
  }
  return files.sort();
}

export async function loadRunHistory(cwd: string): Promise<{ records: RunLoadResult[]; warnings: string[] }> {
  const projectRoot = await fs.realpath(cwd).catch(() => path.resolve(cwd));
  const files = await discoverRunFiles(cwd);
  const records = await mapWithConcurrency(files, DEFAULT_IO_CONCURRENCY, loadRunFile);
  const warnings = records.flatMap((record) => record.ok
    ? record.warnings.map((warning) => `${path.relative(projectRoot, record.path)}: ${warning}`)
    : [`${path.relative(projectRoot, record.path)}: ${record.error}`]);
  return { records, warnings };
}

export async function findLatestRunFile(cwd: string): Promise<string> {
  const projectRoot = await fs.realpath(cwd).catch(() => path.resolve(cwd));
  const runsDirectory = path.join(projectRoot, ".ariadne", "runs");
  const pointerPath = path.join(runsDirectory, "latest.json");
  if (await fs.pathExists(pointerPath)) {
    try {
      const pointer = await fs.readJson(pointerPath) as { manifest?: unknown };
      if (typeof pointer.manifest === "string") {
        const candidate = path.resolve(runsDirectory, pointer.manifest);
        if (isPathInside(runsDirectory, await canonicalizePath(candidate)) && await fs.pathExists(candidate)) return candidate;
      }
    } catch {
      // Fall through to deterministic history lookup.
    }
  }

  const history = await loadRunHistory(projectRoot);
  const valid = history.records.filter((record): record is Extract<RunLoadResult, { ok: true }> => record.ok);
  valid.sort((left, right) => right.run.startedAt.localeCompare(left.run.startedAt) || right.path.localeCompare(left.path));
  if (valid.length === 0) throw new Error(`No valid run records found in ${runsDirectory}. Run "ariadne run" first.`);
  return valid[0].path;
}

export async function resolveRunFile(cwd: string, idOrPath: string): Promise<string> {
  const projectRoot = await fs.realpath(cwd).catch(() => path.resolve(cwd));
  const candidate = idOrPath.includes("/") || idOrPath.includes("\\") || idOrPath.endsWith(".json")
    ? path.resolve(projectRoot, idOrPath)
    : path.join(projectRoot, ".ariadne", "runs", idOrPath, "run.json");
  const resolved = await canonicalizePath(candidate);
  if (!isPathInside(projectRoot, resolved)) {
    throw new AriadneError({
      category: "configuration", code: "RUN_PATH_OUTSIDE_ROOT", stage: "validated",
      message: "Run record path must stay inside the project root.", fieldPath: "run", offendingValue: idOrPath,
      expected: "A run ID or project-relative path without traversal.", correction: "Choose a run record inside the invocation root."
    });
  }
  return candidate;
}
