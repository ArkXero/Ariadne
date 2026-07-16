import crypto from "node:crypto";
import path from "node:path";
import { execa } from "execa";
import fs from "fs-extra";
import { atomicWriteFile, atomicWriteJson } from "./atomic.js";
import { matchesFilePattern, normalizeRepositoryPath } from "./path-match.js";
import type { ChangeArtifact, ChangeEvidence, CapturedChange, RepositoryEntry, SensitivePathEvidence } from "../types/index.js";

const GIT_TIMEOUT_MS = 30_000;
const PREVIEW_BYTES = 128 * 1024;
const SENSITIVE_PATTERNS = [".env", ".env.*", "*.pem", "*.key", "id_rsa", "id_ed25519", "credentials.json"];

async function git(cwd: string, args: string[], options: { input?: Buffer; encoding?: "buffer" } = {}): Promise<{ stdout: string | Buffer; stderr: string; exitCode: number }> {
  try {
    const result = await execa("git", args, {
      cwd, reject: false, timeout: GIT_TIMEOUT_MS, stripFinalNewline: false,
      ...(options.input ? { input: options.input } : {}), ...(options.encoding ? { encoding: options.encoding } : {})
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
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const [added, deleted, ...file] = line.split("\t");
    const filePath = normalizeRepositoryPath(file.join("\t"));
    const binary = added === "-" || deleted === "-";
    result.set(filePath, { additions: binary ? null : Number(added), deletions: binary ? null : Number(deleted), binary });
  }
  return result;
}

function captureChanges(
  changes: ChangeEvidence[],
  stats: Map<string, { additions: number | null; deletions: number | null; binary: boolean }>,
  finalEntries: RepositoryEntry[]
): CapturedChange[] {
  const entries = new Map(finalEntries.map((entry) => [entry.path, entry]));
  return changes.map((change) => {
    const stat = stats.get(change.path) ?? { additions: null, deletions: null, binary: false };
    const entry = entries.get(change.path);
    return {
      path: change.path,
      ...(change.originalPath ? { originalPath: change.originalPath } : {}),
      changeType: change.changeType,
      ...stat,
      ...(entry?.mode ? { mode: entry.mode } : {}),
      ...(entry?.kind ? { kind: entry.kind } : {})
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
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
  const [patch, preview, numstat] = await Promise.all([
    git(options.checkout, ["diff", "--binary", "--full-index", options.preparedRevision, diffTarget], { encoding: "buffer" }),
    git(options.checkout, ["diff", "--no-ext-diff", options.preparedRevision, diffTarget], { encoding: "buffer" }),
    git(options.checkout, ["diff", "--numstat", options.preparedRevision, diffTarget])
  ]);
  if (patch.exitCode !== 0 || preview.exitCode !== 0 || numstat.exitCode !== 0) throw new Error("Could not generate result change artifacts.");
  const patchBytes = Buffer.from(patch.stdout);
  const previewBytes = Buffer.from(preview.stdout).subarray(0, PREVIEW_BYTES);
  await atomicWriteFile(patchPath, patchBytes);
  await atomicWriteFile(previewPath, previewBytes);
  const stats = parseNumstat(String(numstat.stdout));
  const applicable = options.executionPassed && omitted.length === 0 && safe.length > 0 && Boolean(resultRevision);
  const artifact: ChangeArtifact = {
    schemaVersion: 1,
    state: safe.length === 0 ? "empty" : "captured",
    sourceRevision: options.sourceRevision,
    preparedRevision: options.preparedRevision,
    ...(resultRevision ? { resultRevision } : {}),
    ...(resultRef ? { resultRef } : {}),
    patchArtifact: relative(options.projectRoot, patchPath),
    previewArtifact: relative(options.projectRoot, previewPath),
    manifestArtifact: relative(options.projectRoot, manifestPath),
    changes: captureChanges(safe, stats, options.finalEntries),
    omittedSensitive: omitted.sort((left, right) => left.path.localeCompare(right.path)),
    applicable,
    ...(!applicable ? { ineligibleReason: omitted.length > 0 ? "Sensitive or forbidden paths were omitted from the result." : safe.length === 0 ? "The safe result is empty." : "The task did not complete successfully without policy violations." } : {})
  };
  await atomicWriteJson(manifestPath, artifact);
  return artifact;
}
