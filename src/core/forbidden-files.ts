import crypto from "node:crypto";
import path from "node:path";
import fs from "fs-extra";
import { hasGlobMagic, matchesFilePattern } from "./path-match.js";

type ForbiddenSnapshot = Record<string, string>;

const SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  ".ariadne/runs"
]);

function normalizeRelative(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

async function fingerprintFile(filePath: string): Promise<string | undefined> {
  const stat = await fs.stat(filePath).catch(() => undefined);
  if (!stat?.isFile()) {
    return undefined;
  }

  const contents = await fs.readFile(filePath).catch(() => undefined);
  if (contents === undefined) {
    return undefined;
  }

  return crypto.createHash("sha256").update(contents).digest("hex");
}

async function walkFiles(cwd: string, currentDirectory: string, files: string[]): Promise<void> {
  const entries = await fs.readdir(currentDirectory, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    const absolutePath = path.join(currentDirectory, entry.name);
    const relativePath = normalizeRelative(path.relative(cwd, absolutePath));

    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(relativePath) || SKIP_DIRECTORIES.has(entry.name)) {
        continue;
      }

      await walkFiles(cwd, absolutePath, files);
      continue;
    }

    if (entry.isFile()) {
      files.push(relativePath);
    }
  }
}

async function collectExistingFilesForPattern(cwd: string, pattern: string): Promise<string[]> {
  if (!hasGlobMagic(pattern)) {
    const absolutePath = path.resolve(cwd, pattern);
    return (await fs.pathExists(absolutePath)) ? [normalizeRelative(pattern)] : [];
  }

  const files: string[] = [];
  await walkFiles(cwd, cwd, files);
  return files.filter((filePath) => matchesFilePattern(filePath, pattern));
}

export async function snapshotForbiddenFiles(cwd: string, patterns: string[]): Promise<ForbiddenSnapshot> {
  const snapshot: ForbiddenSnapshot = {};

  for (const pattern of patterns) {
    const files = await collectExistingFilesForPattern(cwd, pattern);
    for (const filePath of files) {
      const fingerprint = await fingerprintFile(path.resolve(cwd, filePath));
      if (fingerprint !== undefined) {
        snapshot[filePath] = fingerprint;
      }
    }
  }

  return snapshot;
}

export function diffForbiddenSnapshots(before: ForbiddenSnapshot, after: ForbiddenSnapshot): string[] {
  const files = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...files].filter((filePath) => before[filePath] !== after[filePath]).sort();
}
