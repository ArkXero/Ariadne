import crypto from "node:crypto";
import path from "node:path";
import { execa } from "execa";
import fs from "fs-extra";
import type { ChangeEvidence, RepositoryChangeType, RepositoryEntry, RepositorySnapshot } from "../types/index.js";

const MAX_UNTRACKED_DIFF_BYTES = 200_000;

interface GitResult {
  stdout: string;
  exitCode: number;
  error?: string;
}

async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const result = await execa("git", args, { cwd, reject: false, stripFinalNewline: false });
    return { stdout: result.stdout, exitCode: result.exitCode ?? 0 };
  } catch (error) {
    return { stdout: "", exitCode: 127, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function isGitRepository(cwd: string): Promise<boolean> {
  const result = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

async function fingerprintPath(cwd: string, filePath: string): Promise<{ fingerprint?: string; mode?: string; kind?: RepositoryEntry["kind"] }> {
  const absolutePath = path.join(cwd, filePath);
  const stat = await fs.lstat(absolutePath).catch(() => undefined);
  if (!stat) return {};
  const mode = (stat.mode & 0o7777).toString(8);
  if (stat.isSymbolicLink()) {
    const target = await fs.readlink(absolutePath).catch(() => "[unreadable]");
    return { fingerprint: crypto.createHash("sha256").update(`symlink:${target}`).digest("hex"), mode, kind: "symlink" };
  }
  if (stat.isDirectory()) {
    return { fingerprint: crypto.createHash("sha256").update(`directory:${mode}`).digest("hex"), mode, kind: "other" };
  }
  if (!stat.isFile()) return { fingerprint: crypto.createHash("sha256").update(`other:${stat.mode}:${stat.size}`).digest("hex"), mode, kind: "other" };
  const contents = await fs.readFile(absolutePath).catch(() => undefined);
  return {
    fingerprint: contents ? crypto.createHash("sha256").update(contents).digest("hex") : undefined,
    mode,
    kind: "file"
  };
}

async function fingerprintDeletedPath(
  cwd: string,
  filePath: string,
  indexMode?: string,
  headMode?: string
): Promise<{ fingerprint?: string; mode?: string; kind?: RepositoryEntry["kind"] }> {
  for (const [revision, gitMode] of [[`:./${filePath}`, indexMode], [`HEAD:./${filePath}`, headMode]] as const) {
    try {
      const result = await execa("git", ["show", revision], { cwd, reject: false, encoding: "buffer", stripFinalNewline: false });
      if (result.exitCode !== 0) continue;
      const contents = Buffer.from(result.stdout);
      const symlink = gitMode === "120000";
      return {
        fingerprint: crypto.createHash("sha256").update(symlink ? `symlink:${contents.toString("utf8")}` : contents).digest("hex"),
        mode: gitMode ? gitMode.slice(-3) : undefined,
        kind: symlink ? "symlink" : "file"
      };
    } catch {
      // Try the next Git object source.
    }
  }
  return {};
}

function relativeStatusPath(filePath: string, repositoryPrefix: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  return repositoryPrefix && normalized.startsWith(repositoryPrefix)
    ? normalized.slice(repositoryPrefix.length)
    : normalized;
}

function changeType(indexStatus: string, worktreeStatus: string, typeRecord: string, modeChanged: boolean, kind?: RepositoryEntry["kind"]): RepositoryChangeType {
  const statuses = `${indexStatus}${worktreeStatus}`;
  if (typeRecord === "?") return "untracked";
  if (typeRecord === "!") return "ignored";
  if (statuses.includes("R")) return "renamed";
  if (statuses.includes("C")) return "copied";
  if (statuses.includes("D")) return "deleted";
  if (statuses.includes("A")) return "added";
  if (statuses.includes("T") || modeChanged) return "mode-changed";
  if (kind === "symlink") return "symlink-changed";
  return "modified";
}

async function parsePorcelain(cwd: string, output: string, repositoryPrefix: string): Promise<RepositoryEntry[]> {
  const records = output.split("\0");
  const entries: RepositoryEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const typeRecord = record[0];
    let filePath = "";
    let originalPath: string | undefined;
    let indexStatus = ".";
    let worktreeStatus = ".";
    let modeChanged = false;
    let headMode: string | undefined;
    let indexMode: string | undefined;

    if (typeRecord === "1" || typeRecord === "u") {
      const fields = record.split(" ");
      [indexStatus, worktreeStatus] = (fields[1] ?? "..").split("");
      modeChanged = new Set(fields.slice(3, 6)).size > 1;
      headMode = fields[3];
      indexMode = fields[4];
      filePath = fields.slice(typeRecord === "1" ? 8 : 10).join(" ");
    } else if (typeRecord === "2") {
      const fields = record.split(" ");
      [indexStatus, worktreeStatus] = (fields[1] ?? "..").split("");
      modeChanged = new Set(fields.slice(3, 6)).size > 1;
      headMode = fields[3];
      indexMode = fields[4];
      filePath = fields.slice(9).join(" ");
      originalPath = records[++index] || undefined;
    } else if (typeRecord === "?" || typeRecord === "!") {
      filePath = record.slice(2);
      indexStatus = typeRecord;
      worktreeStatus = typeRecord;
    } else {
      continue;
    }

    filePath = relativeStatusPath(filePath, repositoryPrefix);
    originalPath = originalPath ? relativeStatusPath(originalPath, repositoryPrefix) : undefined;
    const fingerprint = `${indexStatus}${worktreeStatus}`.includes("D")
      ? await fingerprintDeletedPath(cwd, filePath, indexMode, headMode)
      : await fingerprintPath(cwd, filePath);
    const type = changeType(indexStatus, worktreeStatus, typeRecord, modeChanged, fingerprint.kind);
    entries.push({
      path: filePath,
      ...(originalPath ? { originalPath } : {}),
      indexStatus,
      worktreeStatus,
      changeType: type,
      ...fingerprint
    });
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function excluded(filePath: string, excludedPrefixes: string[]): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/\/$/, "");
  return excludedPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`) || prefix.startsWith(`${normalized}/`));
}

export async function captureRepositorySnapshot(cwd: string, excludedPrefixes: string[] = []): Promise<RepositorySnapshot> {
  const repository = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (repository.exitCode !== 0 || repository.stdout.trim() !== "true") {
    return {
      available: false,
      unavailableReason: repository.error ?? "Working directory is not inside a Git repository.",
      dirty: false,
      entries: [],
      diffLineCount: 0
    };
  }

  const [status, head, branch, prefix, diff] = await Promise.all([
    git(cwd, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignored=matching", "--", "."]),
    git(cwd, ["rev-parse", "HEAD"]),
    git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    git(cwd, ["rev-parse", "--show-prefix"]),
    getGitDiff(cwd, excludedPrefixes)
  ]);
  if (status.exitCode !== 0) {
    return {
      available: false,
      unavailableReason: status.error ?? "git status failed.",
      dirty: false,
      entries: [],
      diffLineCount: 0
    };
  }
  const repositoryPrefix = prefix.exitCode === 0 ? prefix.stdout.trim().replace(/\\/g, "/") : "";
  const entries = (await parsePorcelain(cwd, status.stdout, repositoryPrefix)).filter((entry) => !excluded(entry.path, excludedPrefixes));
  return {
    available: true,
    head: head.exitCode === 0 ? head.stdout.trim() : undefined,
    branch: branch.exitCode === 0 ? branch.stdout.trim() : undefined,
    detached: branch.exitCode !== 0,
    dirty: entries.length > 0,
    entries,
    diffLineCount: countDiffChangedLines(diff)
  };
}

function entryIdentity(entry: RepositoryEntry | undefined): string {
  if (!entry) return "[clean-or-missing]";
  return JSON.stringify({
    path: entry.path,
    originalPath: entry.originalPath,
    indexStatus: entry.indexStatus,
    worktreeStatus: entry.worktreeStatus,
    changeType: entry.changeType,
    kind: entry.kind,
    mode: entry.mode,
    fingerprint: entry.fingerprint
  });
}

export function diffRepositorySnapshots(
  before: RepositorySnapshot,
  after: RepositorySnapshot,
  source: ChangeEvidence["source"]
): ChangeEvidence[] {
  if (!before.available || !after.available) return [];
  const beforeMap = new Map(before.entries.map((entry) => [entry.path, entry]));
  const afterMap = new Map(after.entries.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort();
  const changes = paths.flatMap((filePath): ChangeEvidence[] => {
    const baseline = beforeMap.get(filePath);
    const final = afterMap.get(filePath);
    if (entryIdentity(baseline) === entryIdentity(final)) return [];
    const removed = Boolean(baseline && !final) || final?.changeType === "deleted";
    return [{
      path: filePath,
      originalPath: final?.originalPath ?? baseline?.originalPath,
      changeType: removed ? "deleted" : final?.changeType ?? baseline?.changeType ?? "modified",
      source,
      baselineFingerprint: baseline?.fingerprint ?? (removed ? final?.fingerprint : undefined),
      finalFingerprint: removed ? undefined : final?.fingerprint
    }];
  });

  const deletedByFingerprint = new Map<string, ChangeEvidence[]>();
  const addedByFingerprint = new Map<string, ChangeEvidence[]>();
  for (const change of changes) {
    if (change.changeType === "deleted" && change.baselineFingerprint) {
      deletedByFingerprint.set(change.baselineFingerprint, [...deletedByFingerprint.get(change.baselineFingerprint) ?? [], change]);
    } else if (["added", "untracked"].includes(change.changeType) && change.finalFingerprint) {
      addedByFingerprint.set(change.finalFingerprint, [...addedByFingerprint.get(change.finalFingerprint) ?? [], change]);
    }
  }

  const replacements = new Map<ChangeEvidence, ChangeEvidence>();
  const consumed = new Set<ChangeEvidence>();
  for (const [fingerprint, deleted] of deletedByFingerprint) {
    const added = addedByFingerprint.get(fingerprint) ?? [];
    if (deleted.length !== 1 || added.length !== 1) continue;
    const [oldChange] = deleted;
    const [newChange] = added;
    consumed.add(oldChange);
    consumed.add(newChange);
    replacements.set(newChange, {
      path: newChange.path,
      originalPath: oldChange.path,
      changeType: "renamed",
      source,
      baselineFingerprint: fingerprint,
      finalFingerprint: fingerprint
    });
  }

  return changes.flatMap((change) => {
    const replacement = replacements.get(change);
    if (replacement) return [replacement];
    return consumed.has(change) ? [] : [change];
  }).sort((left, right) => left.path.localeCompare(right.path));
}

export function combineTaskChanges(agent: ChangeEvidence[], verification: ChangeEvidence[]): ChangeEvidence[] {
  const map = new Map<string, ChangeEvidence>();
  for (const change of agent) map.set(change.path, change);
  for (const change of verification) {
    const existing = map.get(change.path);
    map.set(change.path, existing ? {
      ...change,
      source: "agent-and-verification",
      baselineFingerprint: existing.baselineFingerprint
    } : change);
  }
  return [...map.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export async function getChangedFiles(cwd: string): Promise<string[]> {
  return (await captureRepositorySnapshot(cwd)).entries.map((entry) => entry.path);
}

export async function getUntrackedFiles(cwd: string): Promise<string[]> {
  const result = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."]);
  return result.exitCode === 0 ? result.stdout.split("\0").filter(Boolean).sort() : [];
}

async function buildUntrackedFileDiff(cwd: string, filePath: string): Promise<string> {
  const absolutePath = path.resolve(cwd, filePath);
  const stat = await fs.lstat(absolutePath).catch(() => undefined);
  if (!stat?.isFile()) return "";
  if (stat.size > MAX_UNTRACKED_DIFF_BYTES) {
    return `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${filePath}\n@@\n+Ariadne omitted untracked file content because file is ${stat.size} bytes.`;
  }
  const contents = await fs.readFile(absolutePath).catch(() => undefined);
  if (!contents || contents.includes(0)) {
    return `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${filePath}\n@@\n+Ariadne omitted binary or unreadable untracked file content.`;
  }
  const lines = contents.toString("utf8").split(/\r?\n/);
  return [`diff --git a/${filePath} b/${filePath}`, "new file mode 100644", "--- /dev/null", `+++ b/${filePath}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join("\n");
}

export async function getGitDiff(cwd: string, excludedPrefixes: string[] = []): Promise<string> {
  if (!(await isGitRepository(cwd))) return "";
  const [unstaged, staged, untracked] = await Promise.all([
    git(cwd, ["diff", "--relative", "--no-ext-diff", "--binary", "--", "."]),
    git(cwd, ["diff", "--cached", "--relative", "--no-ext-diff", "--binary", "--", "."]),
    getUntrackedFiles(cwd)
  ]);
  const untrackedDiffs = await Promise.all(untracked.filter((filePath) => !excluded(filePath, excludedPrefixes)).map((filePath) => buildUntrackedFileDiff(cwd, filePath)));
  return [unstaged.stdout.trimEnd(), staged.stdout.trimEnd(), ...untrackedDiffs.map((value) => value.trimEnd())].filter(Boolean).join("\n\n");
}

export function countDiffChangedLines(diff: string): number {
  return diff.split(/\r?\n/).filter((line) => !line.startsWith("+++") && !line.startsWith("---") && (line.startsWith("+") || line.startsWith("-"))).length;
}
