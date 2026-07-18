import crypto from "node:crypto";
import path from "node:path";
import { execa } from "execa";
import fs from "fs-extra";
import { atomicWriteFile, atomicWriteJson } from "./atomic.js";
import { DEFAULT_PROCESS_CONCURRENCY, mapWithConcurrency } from "./bounded-map.js";
import { matchesFilePattern, normalizeRepositoryPath } from "./path-match.js";
import {
  CURRENT_CHANGE_ARTIFACT_SCHEMA_VERSION,
  type ChangeArtifact,
  type ChangeEvidence,
  type CapturedChange,
  type CapturedDiffMetadata,
  type CapturedObjectMetadata,
  type RepositoryEntry,
  type SensitivePathEvidence
} from "../types/index.js";

const GIT_TIMEOUT_MS = 30_000;
const PREVIEW_BYTES = 128 * 1024;
export const MAX_TUI_FILE_DIFF_BYTES = 8 * 1024 * 1024;
export const MAX_TUI_FILE_DIFF_HUNKS = 1_000;
const SENSITIVE_PATTERNS = [".env", ".env.*", "*.pem", "*.key", "id_rsa", "id_ed25519", "credentials.json"];

async function git(cwd: string, args: string[], options: { input?: Buffer; encoding?: "buffer"; maxBuffer?: number } = {}): Promise<{ stdout: string | Buffer; stderr: string; exitCode: number }> {
  try {
    const result = await execa("git", args, {
      cwd, reject: false, timeout: GIT_TIMEOUT_MS, stripFinalNewline: false,
      ...(options.input ? { input: options.input } : {}), ...(options.encoding ? { encoding: options.encoding } : {}),
      ...(options.maxBuffer ? { maxBuffer: options.maxBuffer } : {})
    });
    return { stdout: typeof result.stdout === "string" ? result.stdout : Buffer.from(result.stdout), stderr: typeof result.stderr === "string" ? result.stderr : Buffer.from(result.stderr).toString("utf8"), exitCode: result.exitCode ?? 0 };
  } catch (error) {
    return { stdout: options.encoding === "buffer" ? Buffer.alloc(0) : "", stderr: error instanceof Error ? error.message : String(error), exitCode: 127 };
  }
}

function relative(root: string, value: string): string {
  return path.relative(root, value).split(path.sep).join("/");
}

function sensitiveRule(filePath: string, forbiddenPatterns: string[]): { reason: string; rule?: string } | undefined {
  const forbidden = forbiddenPatterns.find((pattern) => matchesFilePattern(filePath, pattern));
  if (forbidden) return { reason: "configured-forbidden-file", rule: forbidden };
  const basename = path.posix.basename(filePath).toLowerCase();
  const highConfidence = SENSITIVE_PATTERNS.find((pattern) => matchesFilePattern(basename, pattern));
  return highConfidence ? { reason: "high-confidence-sensitive-file", rule: highConfidence } : undefined;
}

async function sensitiveEvidence(checkout: string, entry: RepositoryEntry | ChangeEvidence, match: { reason: string; rule?: string }): Promise<SensitivePathEvidence> {
  const absolute = path.join(checkout, entry.path);
  const stat = await fs.lstat(absolute).catch(() => undefined);
  let hash: string | undefined;
  if (stat?.isSymbolicLink()) hash = crypto.createHash("sha256").update(`symlink:${await fs.readlink(absolute).catch(() => "[unreadable]")}`).digest("hex");
  else if (stat?.isFile()) hash = crypto.createHash("sha256").update(await fs.readFile(absolute).catch(() => Buffer.from("[unreadable]"))).digest("hex");
  return {
    path: normalizeRepositoryPath(entry.path), reason: match.reason, ...(match.rule ? { rule: match.rule } : {}),
    ...(stat ? { size: stat.size, kind: stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : "other" } : {}), ...(hash ? { sha256: hash } : {})
  };
}

function parseNumstat(output: string): Map<string, { additions: number | null; deletions: number | null; binary: boolean }> {
  const result = new Map<string, { additions: number | null; deletions: number | null; binary: boolean }>();
  const records = output.includes("\0") ? output.split("\0") : output.split(/\r?\n/);
  for (let index = 0; index < records.length;) {
    const line = records[index++]!;
    if (!line) continue;
    const [added, deleted, ...file] = line.split("\t");
    let rawPath = file.join("\t");
    if (!rawPath && output.includes("\0")) {
      index += 1;
      rawPath = records[index++] ?? "";
    }
    const filePath = normalizeRepositoryPath(rawPath);
    const binary = added === "-" || deleted === "-";
    result.set(filePath, { additions: binary ? null : Number(added), deletions: binary ? null : Number(deleted), binary });
  }
  return result;
}

function parseMovements(output: string): Map<string, { originalPath: string; changeType: "renamed" | "copied"; similarity: number }> {
  const result = new Map<string, { originalPath: string; changeType: "renamed" | "copied"; similarity: number }>();
  const records = output.split("\0");
  for (let index = 0; index < records.length;) {
    const header = records[index++] ?? "";
    if (!header) continue;
    const match = / ([RC])(\d+)$/.exec(header);
    if (match) {
      const oldPath = records[index++] ?? "";
      const newPath = records[index++] ?? "";
      if (oldPath && newPath) result.set(normalizeRepositoryPath(newPath), {
        originalPath: normalizeRepositoryPath(oldPath),
        changeType: match[1] === "R" ? "renamed" : "copied",
        similarity: Number(match[2])
      });
    } else index += 1;
  }
  return result;
}

function baseCapturedChanges(
  changes: ChangeEvidence[],
  stats: Map<string, { additions: number | null; deletions: number | null; binary: boolean }>,
  finalEntries: RepositoryEntry[],
  movements: Map<string, { originalPath: string; changeType: "renamed" | "copied"; similarity: number }>
): CapturedChange[] {
  const entries = new Map(finalEntries.map((entry) => [entry.path, entry]));
  return changes.map((change) => {
    const stat = stats.get(change.path) ?? { additions: null, deletions: null, binary: false };
    const entry = entries.get(change.path);
    const movement = movements.get(change.path);
    return {
      path: change.path,
      ...(movement?.originalPath || change.originalPath ? { originalPath: movement?.originalPath ?? change.originalPath } : {}),
      changeType: movement?.changeType ?? change.changeType,
      ...stat,
      ...(movement ? { similarity: movement.similarity } : {}),
      ...(entry?.mode ? { mode: entry.mode } : {}),
      ...(entry?.kind ? { kind: entry.kind } : {})
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function changeId(change: Pick<ChangeEvidence, "changeType" | "originalPath" | "path">): string {
  return crypto.createHash("sha256").update(`${change.changeType}\0${change.originalPath ?? ""}\0${change.path}`).digest("hex").slice(0, 20);
}

async function objectMetadata(checkout: string, revision: string, filePath: string): Promise<CapturedObjectMetadata | undefined> {
  const listed = await git(checkout, ["ls-tree", "-l", "-z", revision, "--", filePath]);
  if (listed.exitCode !== 0 || typeof listed.stdout !== "string" || !listed.stdout) return undefined;
  const header = listed.stdout.split("\0", 1)[0] ?? "";
  const match = /^(\d+)\s+(\S+)\s+([0-9a-f]+)\s+(-|\d+)\t/.exec(header);
  if (!match) return undefined;
  const [, mode, objectType, objectId, rawSize] = match;
  const kind: CapturedObjectMetadata["kind"] = mode === "120000" ? "symlink" : objectType === "blob" ? "file" : "other";
  let symlinkTarget: string | undefined;
  if (kind === "symlink") {
    const target = await git(checkout, ["cat-file", "-p", objectId!]);
    if (target.exitCode === 0 && typeof target.stdout === "string") symlinkTarget = target.stdout.replace(/\r?\n$/, "");
  }
  return {
    path: normalizeRepositoryPath(filePath), mode, kind,
    ...(rawSize !== "-" ? { size: Number(rawSize) } : {}), objectId,
    ...(symlinkTarget !== undefined ? { symlinkTarget } : {})
  };
}

async function fileDiff(
  projectRoot: string,
  checkout: string,
  artifactDirectory: string,
  preparedRevision: string,
  resultRevision: string,
  change: Pick<ChangeEvidence, "changeType" | "originalPath" | "path">,
  binary: boolean
): Promise<CapturedDiffMetadata> {
  const id = changeId(change);
  if (binary) return { status: "binary", bytes: 0, lines: 0, hunks: 0, reason: "Binary content is metadata-only." };
  const paths = [...new Set([change.originalPath, change.path].filter((value): value is string => Boolean(value)))];
  const result = await git(checkout, [
    "diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--find-copies", "--find-copies-harder", preparedRevision, resultRevision, "--", ...paths
  ], { encoding: "buffer", maxBuffer: MAX_TUI_FILE_DIFF_BYTES + 1 });
  if (result.exitCode !== 0) {
    const oversized = /maxBuffer|buffer/i.test(result.stderr);
    return { status: oversized ? "metadata-only" : "unavailable", bytes: 0, lines: 0, hunks: 0, reason: oversized ? "Diff exceeds the 8 MiB TUI artifact limit." : "Git could not create a safe per-file diff." };
  }
  const contents = Buffer.from(result.stdout);
  const lines = contents.length === 0 ? 0 : contents.toString("utf8").split(/\r?\n/).length;
  const hunks = contents.toString("utf8").split(/\r?\n/).filter((line) => line.startsWith("@@ ")).length;
  if (contents.length > MAX_TUI_FILE_DIFF_BYTES || hunks > MAX_TUI_FILE_DIFF_HUNKS) {
    return {
      status: "metadata-only", bytes: contents.length, lines, hunks,
      reason: contents.length > MAX_TUI_FILE_DIFF_BYTES ? "Diff exceeds the 8 MiB TUI artifact limit." : "Diff exceeds the 1,000-hunk TUI artifact limit."
    };
  }
  const diffPath = path.join(artifactDirectory, "changes", "files", `${id}.diff`);
  await atomicWriteFile(diffPath, contents);
  return {
    status: "text", artifact: relative(projectRoot, diffPath),
    bytes: contents.length, lines, hunks, sha256: crypto.createHash("sha256").update(contents).digest("hex")
  };
}

async function enrichChanges(
  projectRoot: string,
  checkout: string,
  artifactDirectory: string,
  preparedRevision: string,
  resultRevision: string,
  captured: CapturedChange[]
): Promise<CapturedChange[]> {
  return mapWithConcurrency(captured, DEFAULT_PROCESS_CONCURRENCY, async (item) => {
    const [oldValue, newValue, diff] = await Promise.all([
      item.changeType === "added" || item.changeType === "untracked" ? undefined : objectMetadata(checkout, preparedRevision, item.originalPath ?? item.path),
      item.changeType === "deleted" ? undefined : objectMetadata(checkout, resultRevision, item.path),
      fileDiff(projectRoot, checkout, artifactDirectory, preparedRevision, resultRevision, item, item.binary)
    ]);
    return {
      ...item, changeId: changeId(item), ...(oldValue ? { old: oldValue } : {}), ...(newValue ? { new: newValue } : {}), diff
    };
  });
}

export async function captureResult(options: {
  projectRoot: string;
  checkout: string;
  artifactDirectory: string;
  runId: string;
  sourceRevision: string;
  preparedRevision: string;
  changes: ChangeEvidence[];
  finalEntries: RepositoryEntry[];
  forbiddenPatterns: string[];
  executionPassed: boolean;
}): Promise<ChangeArtifact> {
  const unique = [...new Map(options.changes.map((change) => [change.path, change])).values()];
  const omitted: SensitivePathEvidence[] = [];
  const safe: ChangeEvidence[] = [];
  for (const change of unique) {
    const match = sensitiveRule(change.path, options.forbiddenPatterns) ?? (change.originalPath ? sensitiveRule(change.originalPath, options.forbiddenPatterns) : undefined);
    if (match) omitted.push(await sensitiveEvidence(options.checkout, change, match));
    else safe.push(change);
  }
  const manifestPath = path.join(options.artifactDirectory, "changes.json");
  const patchPath = path.join(options.artifactDirectory, "changes.patch");
  const previewPath = path.join(options.artifactDirectory, "changes.preview.diff");
  await fs.ensureDir(options.artifactDirectory);

  let resultRevision: string | undefined;
  let resultRef: string | undefined;
  if (safe.length > 0) {
    const reset = await git(options.checkout, ["reset", "--mixed", "--quiet", options.preparedRevision]);
    if (reset.exitCode !== 0) throw new Error(`Could not reset the capture index to the prepared revision: ${reset.stderr}`);
    const safePaths = [...new Set(safe.flatMap((change) => [change.path, ...(change.originalPath ? [change.originalPath] : [])]))];
    const pathspec = Buffer.from(`${safePaths.join("\0")}\0`);
    const staged = await git(options.checkout, ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], { input: pathspec });
    if (staged.exitCode !== 0) throw new Error(`Could not stage safe result paths: ${staged.stderr}`);
    const committed = await execa("git", ["commit", "--no-gpg-sign", "-m", `Ariadne result ${options.runId}`], {
      cwd: options.checkout, reject: false, timeout: GIT_TIMEOUT_MS,
      env: {
        GIT_AUTHOR_NAME: "Ariadne", GIT_AUTHOR_EMAIL: "ariadne@local.invalid",
        GIT_COMMITTER_NAME: "Ariadne", GIT_COMMITTER_EMAIL: "ariadne@local.invalid"
      }
    });
    if (committed.exitCode !== 0) throw new Error(`Could not commit safe result paths: ${committed.stderr}`);
    const resolved = await git(options.checkout, ["rev-parse", "HEAD"]);
    if (resolved.exitCode !== 0 || typeof resolved.stdout !== "string") throw new Error("Could not resolve the result commit.");
    resultRevision = resolved.stdout.trim();
    resultRef = `refs/ariadne/results/${options.runId}`;
    const updated = await git(options.projectRoot, ["update-ref", resultRef, resultRevision, "0000000000000000000000000000000000000000"]);
    if (updated.exitCode !== 0) throw new Error(`Could not create result ref: ${updated.stderr}`);
  }

  const diffTarget = resultRevision ?? options.preparedRevision;
  const [patch, preview, numstat, raw] = await Promise.all([
    git(options.checkout, ["diff", "--binary", "--full-index", options.preparedRevision, diffTarget], { encoding: "buffer" }),
    git(options.checkout, ["diff", "--no-ext-diff", options.preparedRevision, diffTarget], { encoding: "buffer" }),
    git(options.checkout, ["diff", "--numstat", "-z", "--find-renames", "--find-copies", "--find-copies-harder", options.preparedRevision, diffTarget]),
    git(options.checkout, ["diff", "--raw", "-z", "--find-renames", "--find-copies", "--find-copies-harder", options.preparedRevision, diffTarget])
  ]);
  if (patch.exitCode !== 0 || preview.exitCode !== 0 || numstat.exitCode !== 0 || raw.exitCode !== 0) throw new Error("Could not generate result change artifacts.");
  const patchBytes = Buffer.from(patch.stdout);
  const previewBytes = Buffer.from(preview.stdout).subarray(0, PREVIEW_BYTES);
  await atomicWriteFile(patchPath, patchBytes);
  await atomicWriteFile(previewPath, previewBytes);
  const stats = parseNumstat(String(numstat.stdout));
  const movements = parseMovements(String(raw.stdout));
  const applicable = options.executionPassed && omitted.length === 0 && safe.length > 0 && Boolean(resultRevision);
  const captured = baseCapturedChanges(safe, stats, options.finalEntries, movements);
  const enriched = resultRevision
    ? await enrichChanges(options.projectRoot, options.checkout, options.artifactDirectory, options.preparedRevision, resultRevision, captured)
    : captured;
  const artifact: ChangeArtifact = {
    schemaVersion: CURRENT_CHANGE_ARTIFACT_SCHEMA_VERSION,
    state: safe.length === 0 ? "empty" : "captured",
    sourceRevision: options.sourceRevision,
    preparedRevision: options.preparedRevision,
    ...(resultRevision ? { resultRevision } : {}),
    ...(resultRef ? { resultRef } : {}),
    patchArtifact: relative(options.projectRoot, patchPath),
    previewArtifact: relative(options.projectRoot, previewPath),
    manifestArtifact: relative(options.projectRoot, manifestPath),
    changes: enriched,
    omittedSensitive: omitted.sort((left, right) => left.path.localeCompare(right.path)),
    applicable,
    ...(!applicable ? { ineligibleReason: omitted.length > 0 ? "Sensitive or forbidden paths were omitted from the result." : safe.length === 0 ? "The safe result is empty." : "The task did not complete successfully without policy violations." } : {})
  };
  await atomicWriteJson(manifestPath, artifact);
  return artifact;
}
