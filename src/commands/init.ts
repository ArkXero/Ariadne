import path from "node:path";
import fs from "fs-extra";

const CONFIG_TEMPLATE = `version: 4

agent:
  # Ariadne sends task.prompt to stdin and exposes ARIADNE_TASK_* metadata.
  command:
    kind: exec
    file: node
    args:
      - "-e"
      - "process.stdin.pipe(process.stdout)"
  timeout_ms: 600000

tasks:
  directory: ".ariadne/tasks"

verification:
  commands: []
  timeout_ms: 300000

execution:
  termination_grace_ms: 2000
  concurrency: 1
  failure_mode: continue
  isolation: shared
  worktree:
    retention: on-failure
    preparation:
      commands: []
      timeout_ms: 600000

checks:
  forbidden_files:
    - ".env"
    - ".env.*"
  max_changed_files: 20
  max_diff_lines: 500
  forbidden_commands:
    - "rm -rf"
`;

const TASK_TEMPLATE = `id: example
name: Example reliability task
dependsOn: []
workspaceMode: mutable
retry:
  attempts: 1
  delayMs: 0
  backoff: fixed
metadata: {}
prompt: |
  Inspect this repository and make the smallest safe change that improves the project.
  Do not edit forbidden files. Run the configured verification command before finishing.
`;

const GITIGNORE_ENTRIES = ["/.ariadne/", "/ariadne.yml"];

export interface InitResult {
  config: "created" | "skipped";
  task: "created" | "skipped";
  runsDirectory: "ready";
  batchesDirectory: "ready";
  worktreesDirectory: "ready";
  promotionsDirectory: "ready";
  gitignore: "created" | "updated" | "unchanged";
}

async function writeIfMissing(filePath: string, contents: string): Promise<"created" | "skipped"> {
  if (await fs.pathExists(filePath)) return "skipped";
  await fs.outputFile(filePath, contents, { mode: 0o600 });
  return "created";
}

async function ensureGitIgnore(cwd: string): Promise<InitResult["gitignore"]> {
  const gitignorePath = path.join(cwd, ".gitignore");
  const exists = await fs.pathExists(gitignorePath);
  const contents = exists ? await fs.readFile(gitignorePath, "utf8") : "";
  const lines = new Set(contents.split(/\r?\n/).map((line) => line.trim()));
  const missing = GITIGNORE_ENTRIES.filter((entry) => !lines.has(entry));
  if (missing.length === 0) return "unchanged";
  const separator = contents.length === 0 ? "" : contents.endsWith("\n") ? "\n" : "\n\n";
  await fs.outputFile(gitignorePath, `${contents}${separator}${["# Ariadne", ...missing, ""].join("\n")}`);
  return exists ? "updated" : "created";
}

export async function initCommand(cwd: string): Promise<InitResult> {
  const tasksDirectory = path.join(cwd, ".ariadne", "tasks");
  await fs.ensureDir(tasksDirectory);
  await fs.ensureDir(path.join(cwd, ".ariadne", "runs"));
  await fs.ensureDir(path.join(cwd, ".ariadne", "batches"));
  await fs.ensureDir(path.join(cwd, ".ariadne", "worktrees"));
  await fs.ensureDir(path.join(cwd, ".ariadne", "promotions"));
  return {
    config: await writeIfMissing(path.join(cwd, "ariadne.yml"), CONFIG_TEMPLATE),
    task: await writeIfMissing(path.join(tasksDirectory, "example.yml"), TASK_TEMPLATE),
    runsDirectory: "ready",
    batchesDirectory: "ready",
    worktreesDirectory: "ready",
    promotionsDirectory: "ready",
    gitignore: await ensureGitIgnore(cwd)
  };
}

export function formatInitResult(result: InitResult): string {
  return [`ariadne.yml ${result.config}`, `.ariadne/tasks/example.yml ${result.task}`, `.ariadne/runs ${result.runsDirectory}`, `.ariadne/batches ${result.batchesDirectory}`, `.ariadne/worktrees ${result.worktreesDirectory}`, `.ariadne/promotions ${result.promotionsDirectory}`, `.gitignore ${result.gitignore}`].join("\n");
}
