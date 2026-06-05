import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { initCommand } from "../src/commands/init.js";
import { loadConfig } from "../src/core/config.js";
import { snapshotForbiddenFiles, diffForbiddenSnapshots } from "../src/core/forbidden-files.js";
import { countDiffChangedLines, getChangedFiles, getGitDiff } from "../src/core/git.js";
import { buildHtmlReport, formatTerminalSummary } from "../src/core/report.js";
import { scoreTaskRun } from "../src/core/scorer.js";
import { loadTasks } from "../src/core/task-loader.js";
import type { AriadneConfig, AriadneRun, CommandExecution, TaskRunResult } from "../src/types/index.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execa("git", args, { cwd });
}

function command(overrides: Partial<CommandExecution> = {}): CommandExecution {
  return {
    command: "true",
    exitCode: 0,
    stdout: "",
    stderr: "",
    runtimeMs: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.001Z",
    timedOut: false,
    ...overrides
  };
}

function config(overrides: Partial<AriadneConfig["checks"]> = {}): AriadneConfig {
  return {
    version: 1,
    agent: {
      command: "cat",
      timeout_ms: 600_000
    },
    tasks: {
      directory: ".ariadne/tasks"
    },
    verification: {
      commands: [],
      timeout_ms: 300_000
    },
    checks: {
      forbidden_files: [],
      forbidden_commands: [],
      ...overrides
    }
  };
}

function runResult(overrides: Partial<Omit<TaskRunResult, "score">> = {}): Omit<TaskRunResult, "score"> {
  return {
    task: {
      id: "task-1",
      name: "Task 1",
      file: "/tmp/task.yml",
      prompt: "Do work."
    },
    agent: command(),
    verification: [],
    trace: {
      gitAvailable: true,
      workspaceDirtyBefore: [],
      changedFiles: [],
      forbiddenFileChanges: [],
      diff: "",
      diffLineCount: 0,
      commandsObserved: []
    },
    ...overrides
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("config loading", () => {
  it("loads valid YAML and applies schema defaults", async () => {
    const cwd = await makeTempDir("ariadne-config-");
    await writeFile(path.join(cwd, "ariadne.yml"), [
      "agent:",
      "  command: cat"
    ].join("\n"));

    const result = await loadConfig(cwd);

    expect(result.path).toBe(path.join(cwd, "ariadne.yml"));
    expect(result.config).toEqual({
      version: 1,
      agent: {
        command: "cat",
        timeout_ms: 600_000
      },
      tasks: {
        directory: ".ariadne/tasks"
      },
      verification: {
        commands: [],
        timeout_ms: 300_000
      },
      checks: {
        forbidden_files: [],
        forbidden_commands: []
      }
    });
  });

  it("rejects invalid config with actionable validation details", async () => {
    const cwd = await makeTempDir("ariadne-config-invalid-");
    await writeFile(path.join(cwd, "ariadne.yml"), [
      "agent:",
      "  command: \"\""
    ].join("\n"));

    await expect(loadConfig(cwd)).rejects.toThrow(/agent\.command is required/);
  });
});

describe("init generation", () => {
  it("generates config and task YAML that load through Ariadne schemas", async () => {
    const cwd = await makeTempDir("ariadne-init-");

    await initCommand(cwd);

    const { config: loadedConfig } = await loadConfig(cwd);
    const tasks = await loadTasks(cwd, loadedConfig.tasks.directory);

    expect(loadedConfig.verification.commands).toEqual([]);
    expect(loadedConfig.checks.forbidden_files).toEqual([".env", ".env.*"]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: "example",
      name: "Example reliability task",
      metadata: {},
      prompt: expect.stringContaining("Inspect this repository")
    });
  });
});

describe("task loading", () => {
  it("loads YAML tasks recursively with deterministic ordering and defaults", async () => {
    const cwd = await makeTempDir("ariadne-tasks-");
    const tasksDir = path.join(cwd, ".ariadne", "tasks");
    await mkdir(path.join(tasksDir, "nested"), { recursive: true });
    await writeFile(path.join(tasksDir, "alpha.yaml"), [
      "prompt: Alpha prompt",
      "metadata:",
      "  difficulty: easy"
    ].join("\n"));
    await writeFile(path.join(tasksDir, "nested", "beta.yml"), [
      "id: custom-beta",
      "name: Custom Beta",
      "prompt: Beta prompt"
    ].join("\n"));

    const tasks = await loadTasks(cwd, ".ariadne/tasks");

    expect(tasks.map((task) => task.id)).toEqual(["alpha", "custom-beta"]);
    expect(tasks[0]).toMatchObject({
      id: "alpha",
      name: "alpha",
      prompt: "Alpha prompt",
      metadata: {
        difficulty: "easy"
      }
    });
    expect(tasks[1]).toMatchObject({
      id: "custom-beta",
      name: "Custom Beta",
      prompt: "Beta prompt"
    });
  });

  it("rejects task YAML without prompt", async () => {
    const cwd = await makeTempDir("ariadne-tasks-invalid-");
    const tasksDir = path.join(cwd, ".ariadne", "tasks");
    await mkdir(tasksDir, { recursive: true });
    await writeFile(path.join(tasksDir, "missing-prompt.yml"), "name: Missing prompt\n");

    await expect(loadTasks(cwd, ".ariadne/tasks")).rejects.toThrow(/prompt/);
  });
});

describe("scorer", () => {
  it("passes when agent, verification, and configured checks pass", () => {
    const score = scoreTaskRun(runResult(), config());

    expect(score.passed).toBe(true);
    expect(score.checks.every((check) => check.passed)).toBe(true);
  });

  it("fails for expected scorer rule violations", () => {
    const score = scoreTaskRun(
      runResult({
        agent: command({ exitCode: 2 }),
        verification: [command({ command: "pnpm test", exitCode: 1 })],
        trace: {
          gitAvailable: true,
          workspaceDirtyBefore: [],
          changedFiles: ["src/a.ts", "src/b.ts", "secrets.txt"],
          forbiddenFileChanges: [".env"],
          diff: "",
          diffLineCount: 7,
          commandsObserved: ["rm -rf dist"]
        }
      }),
      config({
        forbidden_files: ["secrets.txt", ".env"],
        max_changed_files: 2,
        max_diff_lines: 5,
        forbidden_commands: ["rm -rf"]
      })
    );

    expect(score.passed).toBe(false);
    expect(score.checks.filter((check) => !check.passed).map((check) => check.name)).toEqual([
      "agent_exit_code",
      "verification",
      "forbidden_files",
      "max_changed_files",
      "max_diff_lines",
      "forbidden_commands"
    ]);
  });

  it("labels passing agent plus failing verification as verification_failed", () => {
    const score = scoreTaskRun(
      runResult({
        agent: command({ exitCode: 0 }),
        verification: [command({ command: "pnpm typecheck", exitCode: 127 })]
      }),
      config()
    );

    expect(score.passed).toBe(false);
    expect(score.status).toBe("verification_failed");
    expect(score.checks.find((check) => check.name === "verification")?.details).toEqual({
      failedCommands: [
        {
          command: "pnpm typecheck",
          exitCode: 127
        }
      ]
    });
  });
});

describe("report output", () => {
  it("separates agent and verification failures with failed command details", () => {
    const taskResult = runResult({
      agent: command({ command: "cat", exitCode: 0 }),
      verification: [
        command({
          command: "pnpm typecheck",
          exitCode: 127,
          stdout: "checking config\n",
          stderr: [
            "startup noise",
            "",
            "sh: pnpm: command not found"
          ].join("\n")
        })
      ]
    });
    const scoredResult: TaskRunResult = {
      ...taskResult,
      score: scoreTaskRun(taskResult, config())
    };
    const run: AriadneRun = {
      version: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:00.010Z",
      durationMs: 10,
      cwd: "/tmp/ariadne",
      configPath: "/tmp/ariadne/ariadne.yml",
      config: config(),
      results: [scoredResult],
      summary: {
        total: 1,
        passed: 0,
        failed: 1,
        status: "verification_failed"
      }
    };

    const terminalSummary = formatTerminalSummary(run);
    const htmlReport = buildHtmlReport(run);

    expect(terminalSummary).toContain("Status: verification_failed");
    expect(terminalSummary).toContain("VERIFICATION_FAILED task-1 - Task 1");
    expect(terminalSummary).toContain("Agent: passed (exit 0");
    expect(terminalSummary).toContain("Verification: failed (1 commands)");
    expect(terminalSummary).toContain("Failed command: pnpm typecheck");
    expect(terminalSummary).toContain("Exit code: 127");
    expect(terminalSummary).toContain("Reason: sh: pnpm: command not found");
    expect(terminalSummary).toContain("Stderr (last 2 useful lines):");
    expect(htmlReport).toContain("Verification Failures");
    expect(htmlReport).toContain("pnpm typecheck");
    expect(htmlReport).toContain("Exit code: 127");
    expect(htmlReport).toContain("Reason: sh: pnpm: command not found");
  });
});

describe("git helpers", () => {
  it("detects tracked and untracked changed files", async () => {
    const cwd = await makeTempDir("ariadne-git-status-");
    await git(cwd, ["init", "--quiet"]);
    await writeFile(path.join(cwd, "README.md"), "before\n");
    await git(cwd, ["add", "README.md"]);
    await git(cwd, [
      "-c",
      "user.name=Ariadne Test",
      "-c",
      "user.email=ariadne@example.test",
      "commit",
      "--quiet",
      "-m",
      "initial"
    ]);
    await mkdir(path.join(cwd, "src"));
    await writeFile(path.join(cwd, "README.md"), "after\n");
    await writeFile(path.join(cwd, "src", "new.ts"), "export const value = 1;\n");

    await expect(getChangedFiles(cwd)).resolves.toEqual(["README.md", "src/new.ts"]);
  });

  it("counts changed diff lines while ignoring diff metadata", async () => {
    const diff = [
      "diff --git a/file.txt b/file.txt",
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
      " unchanged",
      "+another"
    ].join("\n");

    expect(countDiffChangedLines(diff)).toBe(3);
  });

  it("includes untracked file content in diff-line counting", async () => {
    const cwd = await makeTempDir("ariadne-git-diff-");
    await git(cwd, ["init", "--quiet"]);
    await writeFile(path.join(cwd, "new.txt"), "one\ntwo");

    const diff = await getGitDiff(cwd);

    expect(diff).toContain("diff --git a/new.txt b/new.txt");
    expect(countDiffChangedLines(diff)).toBe(2);
  });
});

describe("forbidden file snapshots", () => {
  it("detects ignored forbidden files such as .env", async () => {
    const cwd = await makeTempDir("ariadne-forbidden-");
    await git(cwd, ["init", "--quiet"]);
    await writeFile(path.join(cwd, ".gitignore"), ".env\n");

    const before = await snapshotForbiddenFiles(cwd, [".env"]);
    await writeFile(path.join(cwd, ".env"), "SECRET=value\n");
    const after = await snapshotForbiddenFiles(cwd, [".env"]);

    expect(diffForbiddenSnapshots(before, after)).toEqual([".env"]);
  });
});
