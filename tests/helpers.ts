import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { execa } from "execa";
import type { AriadneConfig, RepositorySnapshot, RepositoryTrace } from "../src/types/index.js";

const directories: string[] = [];

export async function tempDir(prefix = "ariadne-test-"): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
}

export async function initGit(cwd: string, files: Record<string, string> = { "README.md": "initial\n" }): Promise<void> {
  await execa("git", ["init", "--quiet"], { cwd });
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
    await writeFile(path.join(cwd, file), contents);
  }
  await execa("git", ["add", "."], { cwd });
  await execa("git", ["-c", "user.name=Ariadne Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "initial"], { cwd });
}

export function config(overrides: Partial<AriadneConfig["checks"]> = {}): AriadneConfig {
  return {
    version: 2,
    sourceVersion: 2,
    agent: { command: { kind: "exec", file: "node", args: ["-e", "process.stdin.resume()"] }, timeout_ms: 1_000 },
    tasks: { directory: ".ariadne/tasks" },
    verification: { commands: [], timeout_ms: 1_000 },
    execution: { termination_grace_ms: 100 },
    checks: { forbidden_files: [], forbidden_commands: [], ...overrides }
  };
}

export function snapshot(entries: RepositorySnapshot["entries"] = []): RepositorySnapshot {
  return { available: true, head: "abc", branch: "main", detached: false, dirty: entries.length > 0, entries, diffLineCount: 0 };
}

export function trace(overrides: Partial<RepositoryTrace> = {}): RepositoryTrace {
  const clean = snapshot();
  return {
    baseline: clean,
    postAgent: clean,
    final: clean,
    preexistingChanges: [],
    agentChanges: [],
    verificationChanges: [],
    taskChanges: [],
    forbiddenFileChanges: [],
    diffLineCount: 0,
    observedCommands: [],
    ...overrides
  };
}

export async function writeProject(cwd: string, options: { agentArgs?: string[]; tasks?: Array<{ id: string; prompt?: string }>; checks?: string } = {}): Promise<void> {
  await mkdir(path.join(cwd, ".ariadne", "tasks"), { recursive: true });
  const args = options.agentArgs ?? ["-e", "process.stdin.resume()"];
  await writeFile(path.join(cwd, "ariadne.yml"), [
    "version: 2",
    "agent:",
    "  command:",
    "    kind: exec",
    "    file: node",
    `    args: ${JSON.stringify(args)}`,
    "  timeout_ms: 1000",
    "tasks:",
    "  directory: .ariadne/tasks",
    "verification:",
    "  commands: []",
    "  timeout_ms: 1000",
    "execution:",
    "  termination_grace_ms: 100",
    "checks:",
    options.checks ?? "  forbidden_files: []\n  forbidden_commands: []"
  ].join("\n"));
  for (const task of options.tasks ?? [{ id: "example" }]) {
    await writeFile(path.join(cwd, ".ariadne", "tasks", `${task.id}.yml`), `id: ${task.id}\nname: ${task.id}\nprompt: ${task.prompt ?? "Do work."}\n`);
  }
}

