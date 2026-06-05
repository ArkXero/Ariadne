import path from "node:path";
import { execa } from "execa";
import fs from "fs-extra";

const MAX_UNTRACKED_DIFF_BYTES = 200_000;

async function git(cwd: string, args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const result = await execa("git", args, {
    cwd,
    reject: false,
    stripFinalNewline: false
  });

  return {
    stdout: result.stdout,
    exitCode: result.exitCode ?? 0
  };
}

export async function isGitRepository(cwd: string): Promise<boolean> {
  const result = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

function stripGitQuotes(filePath: string): string {
  const trimmed = filePath.trim();
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1).replace(/\\"/g, "\"");
  }

  return trimmed;
}

function parseStatusFile(line: string): string | undefined {
  const filePart = line.slice(3);
  if (!filePart) {
    return undefined;
  }

  const renamedTarget = filePart.includes(" -> ") ? filePart.split(" -> ").at(-1) : filePart;
  return renamedTarget ? stripGitQuotes(renamedTarget) : undefined;
}

export async function getChangedFiles(cwd: string): Promise<string[]> {
  if (!(await isGitRepository(cwd))) {
    return [];
  }

  const status = await git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.exitCode !== 0 || !status.stdout.trim()) {
    return [];
  }

  const files = status.stdout
    .split(/\r?\n/)
    .map((line) => parseStatusFile(line))
    .filter((filePath): filePath is string => Boolean(filePath));

  return [...new Set(files)].sort();
}

export async function getUntrackedFiles(cwd: string): Promise<string[]> {
  if (!(await isGitRepository(cwd))) {
    return [];
  }

  const result = await git(cwd, ["ls-files", "--others", "--exclude-standard"]);
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return [];
  }

  return result.stdout.split(/\r?\n/).filter(Boolean).sort();
}

async function buildUntrackedFileDiff(cwd: string, filePath: string): Promise<string> {
  const absolutePath = path.resolve(cwd, filePath);
  const stat = await fs.stat(absolutePath);

  if (!stat.isFile()) {
    return "";
  }

  if (stat.size > MAX_UNTRACKED_DIFF_BYTES) {
    return [
      `diff --git a/${filePath} b/${filePath}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${filePath}`,
      "@@",
      `+Ariadne omitted untracked file content because file is ${stat.size} bytes.`
    ].join("\n");
  }

  const contents = await fs.readFile(absolutePath, "utf8").catch(() => undefined);
  if (contents === undefined || contents.includes("\0")) {
    return [
      `diff --git a/${filePath} b/${filePath}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${filePath}`,
      "@@",
      "+Ariadne omitted binary or unreadable untracked file content."
    ].join("\n");
  }

  const lines = contents.length > 0 ? contents.split(/\r?\n/) : [];
  return [
    `diff --git a/${filePath} b/${filePath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`)
  ].join("\n");
}

export async function getGitDiff(cwd: string): Promise<string> {
  if (!(await isGitRepository(cwd))) {
    return "";
  }

  const unstaged = await git(cwd, ["diff", "--no-ext-diff", "--"]);
  const staged = await git(cwd, ["diff", "--cached", "--no-ext-diff", "--"]);
  const untrackedFiles = await getUntrackedFiles(cwd);
  const untrackedDiffs = await Promise.all(untrackedFiles.map((filePath) => buildUntrackedFileDiff(cwd, filePath)));

  return [
    unstaged.stdout.trimEnd(),
    staged.stdout.trimEnd(),
    ...untrackedDiffs.map((diff) => diff.trimEnd())
  ].filter(Boolean).join("\n\n");
}

export function countDiffChangedLines(diff: string): number {
  if (!diff.trim()) {
    return 0;
  }

  return diff.split(/\r?\n/).filter((line) => {
    if (line.startsWith("+++") || line.startsWith("---")) {
      return false;
    }

    return line.startsWith("+") || line.startsWith("-");
  }).length;
}
