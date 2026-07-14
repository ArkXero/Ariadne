import crypto from "node:crypto";
import path from "node:path";
import { execa } from "execa";
import fs from "fs-extra";
import { hasGlobMagic, matchesFilePattern, normalizeRepositoryPath } from "./path-match.js";
import type { ChangeEvidence, ForbiddenFileEvidence } from "../types/index.js";

export interface ForbiddenFileState {
  rule: string;
  fingerprint: string;
  kind: "file" | "symlink" | "other";
  mode: string;
}

export type ForbiddenSnapshot = Record<string, ForbiddenFileState>;
const SKIP = new Set([".git"]);

async function fingerprint(filePath: string): Promise<Omit<ForbiddenFileState, "rule"> | undefined> {
  const stat = await fs.lstat(filePath).catch(() => undefined);
  if (!stat) return undefined;
  const mode = (stat.mode & 0o7777).toString(8);
  if (stat.isSymbolicLink()) {
    const target = await fs.readlink(filePath).catch(() => "[unreadable]");
    return { fingerprint: crypto.createHash("sha256").update(`symlink:${target}`).digest("hex"), kind: "symlink", mode };
  }
  if (stat.isFile()) {
    const contents = await fs.readFile(filePath).catch(() => Buffer.from("[unreadable]"));
    return { fingerprint: crypto.createHash("sha256").update(contents).digest("hex"), kind: "file", mode };
  }
  return { fingerprint: crypto.createHash("sha256").update(`other:${stat.mode}:${stat.size}`).digest("hex"), kind: "other", mode };
}

async function walk(root: string, current: string, patterns: string[], snapshot: ForbiddenSnapshot): Promise<void> {
  const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = normalizeRepositoryPath(path.relative(root, absolute));
    if (entry.isDirectory() && (SKIP.has(entry.name) || relative === ".ariadne/runs" || relative.startsWith(".ariadne/runs/"))) continue;
    const rule = patterns.find((pattern) => matchesFilePattern(relative, pattern));
    if (rule) {
      const state = await fingerprint(absolute);
      if (state) snapshot[relative] = { rule, ...state };
    }
    if (entry.isDirectory()) await walk(root, absolute, patterns, snapshot);
  }
}

async function gitPaths(root: string): Promise<string[] | undefined> {
  const repository = await execa("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, reject: false }).catch(() => undefined);
  if (repository?.exitCode !== 0 || repository.stdout.trim() !== "true") return undefined;
  const [visible, ignored] = await Promise.all([
    execa("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."], { cwd: root, reject: false, stripFinalNewline: false }),
    execa("git", ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", "."], { cwd: root, reject: false, stripFinalNewline: false })
  ]);
  if (visible.exitCode !== 0 || ignored.exitCode !== 0) return undefined;
  return [...new Set(`${visible.stdout}\0${ignored.stdout}`.split("\0").filter(Boolean).map(normalizeRepositoryPath))].sort();
}

async function snapshotForbiddenDirectories(root: string, patterns: string[], snapshot: ForbiddenSnapshot): Promise<void> {
  const directoryPatterns = patterns.filter((pattern) => pattern.endsWith("/"));
  const exactPatterns = directoryPatterns.filter((pattern) => !hasGlobMagic(pattern));
  for (const rule of exactPatterns) {
    const relative = normalizeRepositoryPath(rule).replace(/\/$/, "");
    const state = await fingerprint(path.join(root, relative));
    if (state?.kind === "other") snapshot[relative] = { rule, ...state };
  }

  const globPatterns = directoryPatterns.filter(hasGlobMagic);
  if (globPatterns.length === 0) return;
  const visit = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const absolute = path.join(current, entry.name);
      const relative = normalizeRepositoryPath(path.relative(root, absolute));
      if (SKIP.has(entry.name) || relative === ".ariadne/runs" || relative.startsWith(".ariadne/runs/")) continue;
      const rule = globPatterns.find((pattern) => matchesFilePattern(relative, pattern));
      if (rule) {
        const state = await fingerprint(absolute);
        if (state) snapshot[relative] = { rule, ...state };
      }
      await visit(absolute);
    }
  };
  await visit(root);
}

export async function snapshotForbiddenFiles(cwd: string, patterns: string[]): Promise<ForbiddenSnapshot> {
  const snapshot: ForbiddenSnapshot = {};
  if (patterns.length === 0) return snapshot;
  await snapshotForbiddenDirectories(cwd, patterns, snapshot);
  const repositoryPaths = await gitPaths(cwd);
  if (!repositoryPaths) {
    await walk(cwd, cwd, patterns, snapshot);
    return snapshot;
  }
  for (const relative of repositoryPaths) {
    if (relative === ".ariadne/runs" || relative.startsWith(".ariadne/runs/")) continue;
    const rule = patterns.find((pattern) => matchesFilePattern(relative, pattern));
    if (!rule) continue;
    const state = await fingerprint(path.join(cwd, relative));
    if (state) snapshot[relative] = { rule, ...state };
  }
  return snapshot;
}

export function diffForbiddenSnapshots(
  before: ForbiddenSnapshot,
  after: ForbiddenSnapshot,
  source: ChangeEvidence["source"] = "agent"
): ForbiddenFileEvidence[] {
  const files = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return files.flatMap((filePath): ForbiddenFileEvidence[] => {
    const previous = before[filePath];
    const current = after[filePath];
    if (JSON.stringify(previous) === JSON.stringify(current)) return [];
    return [{
      path: filePath,
      changeType: !previous ? "added" : !current ? "deleted" : previous.kind === "symlink" || current.kind === "symlink" ? "symlink-changed" : previous.mode !== current.mode ? "mode-changed" : "modified",
      source,
      rule: current?.rule ?? previous?.rule ?? "unknown",
      baselineFingerprint: previous?.fingerprint,
      finalFingerprint: current?.fingerprint,
      ...(previous ? { baselineState: { fingerprint: previous.fingerprint, kind: previous.kind, mode: previous.mode } } : {}),
      ...(current ? { finalState: { fingerprint: current.fingerprint, kind: current.kind, mode: current.mode } } : {})
    }];
  });
}
