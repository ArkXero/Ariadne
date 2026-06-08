import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { initCommand } from "../src/commands/init.js";
import { loadConfig } from "../src/core/config.js";
import { diagnoseRepository, formatDoctorReport } from "../src/core/doctor.js";
import { snapshotForbiddenFiles, diffForbiddenSnapshots } from "../src/core/forbidden-files.js";
import { countDiffChangedLines, getChangedFiles, getGitDiff } from "../src/core/git.js";
import { buildHtmlReport, formatRunCompletion, formatTerminalSummary } from "../src/core/report.js";
import { formatRunCsv, formatRunList, listRuns, writeRunCsv } from "../src/core/runs.js";
import { runAriadne } from "../src/core/runner.js";
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
    list: {
      csv: {
        enabled: false,
        path: ".ariadne/runs/runs.csv"
      }
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
      list: {
        csv: {
          enabled: false,
          path: ".ariadne/runs/runs.csv"
        }
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
    expect(loadedConfig.list.csv).toEqual({
      enabled: false,
      path: ".ariadne/runs/runs.csv"
    });
    expect(loadedConfig.checks.forbidden_files).toEqual([".env", ".env.*"]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: "example",
      name: "Example reliability task",
      metadata: {},
      prompt: expect.stringContaining("Inspect this repository")
    });
  });

  it("adds Ariadne files to .gitignore without replacing existing entries", async () => {
    const cwd = await makeTempDir("ariadne-init-ignore-");
    const gitignorePath = path.join(cwd, ".gitignore");
    await writeFile(gitignorePath, "node_modules/\n");

    await initCommand(cwd);
    await initCommand(cwd);

    expect(await readFile(gitignorePath, "utf8")).toBe([
      "node_modules/",
      "",
      "# Ariadne",
      "/.ariadne/",
      "/ariadne.yml",
      ""
    ].join("\n"));
  });
});

describe("doctor", () => {
  it("passes when config, tasks, agent, and verification commands are valid", async () => {
    const cwd = await makeTempDir("ariadne-doctor-pass-");
    await mkdir(path.join(cwd, ".ariadne", "tasks"), { recursive: true });
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({
      scripts: {
        typecheck: "tsc --noEmit"
      }
    }));
    await writeFile(path.join(cwd, "ariadne.yml"), [
      "agent:",
      "  command: node agent.mjs",
      "verification:",
      "  commands:",
      "    - pnpm typecheck"
    ].join("\n"));
    await writeFile(path.join(cwd, ".ariadne", "tasks", "task.yml"), "prompt: Check repository.\n");

    const report = await diagnoseRepository(cwd);
    const output = formatDoctorReport(report);

    expect(report.passed).toBe(true);
    expect(report.errors).toBe(0);
    expect(output).toContain("PASS config:");
    expect(output).toContain("PASS tasks: Loaded 1 valid task file");
    expect(output).toContain('PASS agent: Executable "node" is available.');
    expect(output).toContain('PASS verification 1 script: package.json script "typecheck" exists.');
    expect(output).toContain("Summary:");
  });

  it("reports missing package.json verification scripts with a suggestion", async () => {
    const cwd = await makeTempDir("ariadne-doctor-missing-script-");
    await mkdir(path.join(cwd, ".ariadne", "tasks"), { recursive: true });
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({
      scripts: {
        test: "vitest run"
      }
    }));
    await writeFile(path.join(cwd, "ariadne.yml"), [
      "agent:",
      "  command: node agent.mjs",
      "verification:",
      "  commands:",
      "    - pnpm typecheck"
    ].join("\n"));
    await writeFile(path.join(cwd, ".ariadne", "tasks", "task.yml"), "prompt: Check repository.\n");

    const report = await diagnoseRepository(cwd);
    const output = formatDoctorReport(report);

    expect(report.passed).toBe(false);
    expect(report.errors).toBe(1);
    expect(output).toContain('ERROR verification 1 script: pnpm script "typecheck" is missing from package.json.');
    expect(output).toContain('Suggestion: Add "typecheck" to package.json scripts, or update command "pnpm typecheck".');
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
    expect(score.status).toBe("passed");
    expect(score.agent).toEqual({
      command: "true",
      passed: true,
      exitCode: 0,
      timedOut: false,
      runtimeMs: 1
    });
    expect(score.verification).toEqual({
      passed: true,
      commands: [],
      failedCommands: []
    });
    expect(score.checks.every((check) => check.passed)).toBe(true);
  });

  it("labels agent failures as agent_failed", () => {
    const score = scoreTaskRun(
      runResult({
        agent: command({ command: "codex exec", exitCode: 2, stderr: "agent crashed\n" })
      }),
      config()
    );

    expect(score.passed).toBe(false);
    expect(score.status).toBe("agent_failed");
    expect(score.agent).toMatchObject({
      command: "codex exec",
      passed: false,
      exitCode: 2,
      timedOut: false
    });
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
    expect(score.verification).toEqual({
      passed: false,
      commands: [
        {
          command: "pnpm typecheck",
          passed: false,
          exitCode: 127,
          timedOut: false,
          runtimeMs: 1
        }
      ],
      failedCommands: [
        {
          command: "pnpm typecheck",
          passed: false,
          exitCode: 127,
          timedOut: false,
          runtimeMs: 1
        }
      ]
    });
    expect(score.checks.find((check) => check.name === "verification")?.details).toEqual({
      failedCommands: [
        {
          command: "pnpm typecheck",
          exitCode: 127,
          timedOut: false
        }
      ]
    });
  });

  it("labels configured check failures as check_failed", () => {
    const score = scoreTaskRun(
      runResult({
        trace: {
          gitAvailable: true,
          workspaceDirtyBefore: [],
          changedFiles: ["src/a.ts", "src/b.ts"],
          forbiddenFileChanges: [],
          diff: "",
          diffLineCount: 0,
          commandsObserved: []
        }
      }),
      config({
        max_changed_files: 1
      })
    );

    expect(score.passed).toBe(false);
    expect(score.status).toBe("check_failed");
    expect(score.checks.find((check) => check.name === "max_changed_files")).toMatchObject({
      passed: false,
      details: {
        count: 2,
        limit: 1
      }
    });
  });

  it("labels command timeouts as timeout", () => {
    const score = scoreTaskRun(
      runResult({
        agent: command({
          command: "sleep 60",
          exitCode: 124,
          timedOut: true,
          runtimeMs: 5000
        })
      }),
      config()
    );

    expect(score.passed).toBe(false);
    expect(score.status).toBe("timeout");
    expect(score.agent).toMatchObject({
      command: "sleep 60",
      passed: false,
      exitCode: 124,
      timedOut: true,
      runtimeMs: 5000
    });
  });
});

describe("report output", () => {
  it("formats run command output as sectioned agent verification and checks", () => {
    const taskResult = runResult({
      task: {
        id: "task-1",
        name: "Explore project and learn report architecture",
        file: "/tmp/task.yml",
        prompt: "Do work."
      },
      agent: command({
        command: "codex exec --sandbox workspace-write",
        exitCode: 0
      }),
      verification: [
        command({ command: "pnpm test", exitCode: 0 }),
        command({
          command: "pnpm check",
          exitCode: 1,
          stderr: "sh: pnpm: command not found\n"
        })
      ]
    });
    const scoredResult: TaskRunResult = {
      ...taskResult,
      score: scoreTaskRun(
        taskResult,
        config({
          max_changed_files: 5,
          max_diff_lines: 10
        })
      )
    };
    const run: AriadneRun & { outputPath: string } = {
      version: 1,
      startedAt: "2026-06-05T19:14:51.000Z",
      completedAt: "2026-06-05T19:16:32.000Z",
      durationMs: 101_000,
      cwd: "/tmp/ariadne",
      configPath: "/tmp/ariadne/ariadne.yml",
      config: config(),
      results: [scoredResult],
      summary: {
        total: 1,
        passed: 0,
        failed: 1,
        status: "verification_failed"
      },
      outputPath: "/tmp/ariadne/.ariadne/runs/2026-06-05T19-14-51-test.json"
    };

    const runOutput = formatRunCompletion(run);

    expect(runOutput).toContain("Ariadne run completed");
    expect(runOutput).toContain("Task: Explore project and learn report architecture");
    expect(runOutput).toContain("Run: 2026-06-05T19-14-51-test");
    expect(runOutput).toContain("Duration: 1m 41s");
    expect(runOutput).toContain("Agent\n  command: codex exec --sandbox workspace-write\n  status: passed\n  exit code: 0");
    expect(runOutput).toContain("Verification\n  pnpm test  passed\n  pnpm check failed");
    expect(runOutput).toContain("Checks\n  forbidden files    passed");
    expect(runOutput).toContain("max files          passed");
    expect(runOutput).toContain("max diff           passed");
    expect(runOutput).toContain("Result: verification_failed");
    expect(runOutput).toContain("Report: .ariadne/runs/2026-06-05T19-14-51-test.json");
  });

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

describe("run list", () => {
  it("lists every run newest first with key details and relative paths", async () => {
    const cwd = await makeTempDir("ariadne-list-");
    const runsDir = path.join(cwd, ".ariadne", "runs");
    await mkdir(runsDir, { recursive: true });
    const older: AriadneRun = {
      version: 1,
      startedAt: "2026-06-07T23:58:00.000Z",
      completedAt: "2026-06-07T23:58:43.000Z",
      durationMs: 43_000,
      cwd,
      configPath: path.join(cwd, "ariadne.yml"),
      config: config(),
      results: [],
      summary: {
        total: 0,
        passed: 0,
        failed: 1,
        status: "check_failed"
      }
    };
    const newer: AriadneRun = {
      ...older,
      startedAt: "2026-06-08T01:35:00.000Z",
      completedAt: "2026-06-08T01:37:14.000Z",
      durationMs: 134_000,
      results: [
        {
          ...runResult({
            task: {
              id: "fix-auth-bug",
              name: "fix-auth-bug",
              file: "/tmp/task.yml",
              prompt: "Fix auth."
            }
          }),
          score: scoreTaskRun(runResult(), config())
        },
        {
          ...runResult(),
          score: scoreTaskRun(runResult(), config())
        }
      ],
      summary: {
        total: 2,
        passed: 2,
        failed: 0,
        status: "passed"
      }
    };

    await writeFile(path.join(runsDir, "older.json"), JSON.stringify(older));
    await writeFile(path.join(runsDir, "newer.json"), JSON.stringify(newer));

    const runs = await listRuns(cwd);
    const output = formatRunList(runs);

    expect(runs).toHaveLength(2);
    expect(runs[0]).toEqual({
      started: "2026-06-08 01:35",
      status: "passed",
      task: "fix-auth-bug +1 more",
      duration: "2m 14s",
      path: ".ariadne/runs/newer.json"
    });
    expect(output.indexOf("newer.json")).toBeLessThan(output.indexOf("older.json"));
    expect(output).toContain("Started           Status        Task                  Duration  Path");
    expect(output).toContain("2026-06-07 23:58  check_failed  none");
  });

  it("formats an empty runs directory with an actionable message", async () => {
    const cwd = await makeTempDir("ariadne-list-empty-");
    await mkdir(path.join(cwd, ".ariadne", "runs"), { recursive: true });

    await expect(listRuns(cwd)).resolves.toEqual([]);
    expect(formatRunList([])).toContain("No runs found. Run \"ariadne run\" first.");
  });

  it("formats and writes CSV with escaped values", async () => {
    const cwd = await makeTempDir("ariadne-list-csv-");
    const runs = [{
      started: "2026-06-08 01:35",
      status: "passed" as const,
      task: "Fix auth, \"again\"",
      duration: "2m 14s",
      path: ".ariadne/runs/newer.json"
    }];

    const outputPath = await writeRunCsv(cwd, ".ariadne/runs/runs.csv", runs);
    const csv = await readFile(outputPath, "utf8");

    expect(csv).toBe(formatRunCsv(runs));
    expect(csv).toContain('"Fix auth, ""again"""');
  });
});

describe("run JSON", () => {
  it("writes structured agent, verification, and check results", async () => {
    const cwd = await makeTempDir("ariadne-run-json-");
    await mkdir(path.join(cwd, ".ariadne", "tasks"), { recursive: true });
    await writeFile(path.join(cwd, "ariadne.yml"), [
      "agent:",
      "  command: node -e \"process.stdout.write('agent ok')\"",
      "verification:",
      "  commands:",
      "    - node -e \"process.stdout.write('verification ok')\"",
      "checks:",
      "  forbidden_commands: []"
    ].join("\n"));
    await writeFile(path.join(cwd, ".ariadne", "tasks", "task.yml"), [
      "id: diagnostics",
      "name: Diagnostics",
      "prompt: Test structured run output."
    ].join("\n"));

    const run = await runAriadne({ cwd });
    const writtenRun = JSON.parse(await readFile(run.outputPath, "utf8")) as AriadneRun;

    expect(writtenRun.summary.status).toBe("passed");
    expect(writtenRun.results[0].score).toMatchObject({
      passed: true,
      status: "passed",
      agent: {
        passed: true,
        exitCode: 0,
        timedOut: false
      },
      verification: {
        passed: true,
        commands: [
          {
            passed: true,
            exitCode: 0,
            timedOut: false
          }
        ],
        failedCommands: []
      }
    });
    expect(writtenRun.results[0].score.checks.length).toBeGreaterThan(0);
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
