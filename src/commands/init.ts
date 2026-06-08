import path from "node:path";
import fs from "fs-extra";

const CONFIG_TEMPLATE = `version: 1

agent:
  # Ariadne sends each task prompt to stdin and also exposes it as ARIADNE_TASK_PROMPT.
  # For Codex, keep the trailing "-" so the task prompt is read from stdin:
  # command: "codex exec --sandbox workspace-write -"
  command: "cat"
  timeout_ms: 600000

tasks:
  directory: ".ariadne/tasks"

verification:
  # Add project-specific checks, for example: "npm test" or "pnpm test".
  commands: []
  timeout_ms: 300000

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
metadata: {}
prompt: |
  Inspect this repository and make the smallest safe change that improves the project.
  Do not edit forbidden files. Run the configured verification command before finishing.
`;

const GITIGNORE_ENTRIES = ["/.ariadne/", "/ariadne.yml"];

async function writeIfMissing(filePath: string, contents: string): Promise<"created" | "skipped"> {
  if (await fs.pathExists(filePath)) {
    return "skipped";
  }

  await fs.outputFile(filePath, contents);
  return "created";
}

async function ensureGitIgnore(cwd: string): Promise<"created" | "updated" | "unchanged"> {
  const gitignorePath = path.join(cwd, ".gitignore");
  const exists = await fs.pathExists(gitignorePath);
  const contents = exists ? await fs.readFile(gitignorePath, "utf8") : "";
  const lines = new Set(contents.split(/\r?\n/).map((line) => line.trim()));
  const missingEntries = GITIGNORE_ENTRIES.filter((entry) => !lines.has(entry));

  if (missingEntries.length === 0) {
    return "unchanged";
  }

  const separator = contents.length === 0 ? "" : contents.endsWith("\n") ? "\n" : "\n\n";
  const block = ["# Ariadne", ...missingEntries, ""].join("\n");
  await fs.outputFile(gitignorePath, `${contents}${separator}${block}`);

  return exists ? "updated" : "created";
}

export async function initCommand(cwd: string): Promise<void> {
  const configPath = path.join(cwd, "ariadne.yml");
  const tasksDir = path.join(cwd, ".ariadne", "tasks");
  const runsDir = path.join(cwd, ".ariadne", "runs");
  const exampleTaskPath = path.join(tasksDir, "example.yml");

  await fs.ensureDir(tasksDir);
  await fs.ensureDir(runsDir);

  const configStatus = await writeIfMissing(configPath, CONFIG_TEMPLATE);
  const taskStatus = await writeIfMissing(exampleTaskPath, TASK_TEMPLATE);
  const gitignoreStatus = await ensureGitIgnore(cwd);

  console.log(`ariadne.yml ${configStatus}`);
  console.log(`.ariadne/tasks/example.yml ${taskStatus}`);
  console.log(".ariadne/runs ready");
  console.log(`.gitignore ${gitignoreStatus}`);
}
