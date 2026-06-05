import path from "node:path";
import { execaCommand } from "execa";
import fs from "fs-extra";
import { loadConfig } from "./config.js";
import { diffForbiddenSnapshots, snapshotForbiddenFiles } from "./forbidden-files.js";
import { countDiffChangedLines, getChangedFiles, getGitDiff, isGitRepository } from "./git.js";
import { scoreTaskRun } from "./scorer.js";
import { loadTasks } from "./task-loader.js";
import type { AriadneRun, CommandExecution, TaskRunResult } from "../types/index.js";

interface RunOptions {
  cwd: string;
  configPath?: string;
}

function timestampForFile(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function runShellCommand(options: {
  command: string;
  cwd: string;
  input?: string;
  timeoutMs: number;
  env?: Record<string, string>;
}): Promise<CommandExecution> {
  const startedAt = new Date().toISOString();
  const start = Date.now();

  try {
    const result = await execaCommand(options.command, {
      cwd: options.cwd,
      shell: true,
      input: options.input,
      reject: false,
      timeout: options.timeoutMs,
      env: options.env,
      stripFinalNewline: false
    });

    return {
      command: options.command,
      exitCode: result.timedOut ? 124 : result.exitCode ?? 0,
      stdout: result.stdout,
      stderr: result.stderr,
      runtimeMs: Date.now() - start,
      startedAt,
      completedAt: new Date().toISOString(),
      timedOut: result.timedOut
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = typeof error === "object" && error !== null && "timedOut" in error && error.timedOut === true;

    return {
      command: options.command,
      exitCode: timedOut ? 124 : 1,
      stdout: "",
      stderr: message,
      runtimeMs: Date.now() - start,
      startedAt,
      completedAt: new Date().toISOString(),
      timedOut
    };
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function extractObservedCommands(logs: string): string[] {
  const observed: string[] = [];
  const commandLike = /^(?:\s*[$>]\s*)?(npm|pnpm|yarn|bun|npx|node|git|rm|cp|mv|mkdir|touch|python|python3|pytest|make|go|cargo|docker|docker-compose)\b.+$/gm;

  for (const match of logs.matchAll(commandLike)) {
    observed.push(match[0].replace(/^\s*[$>]\s*/, "").trim());
  }

  return unique(observed);
}

async function runTask(input: {
  cwd: string;
  config: AriadneRun["config"];
  task: TaskRunResult["task"];
  gitAvailable: boolean;
}): Promise<TaskRunResult> {
  const workspaceDirtyBefore = await getChangedFiles(input.cwd);
  const forbiddenFilesBefore = await snapshotForbiddenFiles(input.cwd, input.config.checks.forbidden_files);
  const agent = await runShellCommand({
    command: input.config.agent.command,
    cwd: input.cwd,
    input: input.task.prompt,
    timeoutMs: input.config.agent.timeout_ms,
    env: {
      ARIADNE_TASK_ID: input.task.id,
      ARIADNE_TASK_NAME: input.task.name,
      ARIADNE_TASK_FILE: input.task.file,
      ARIADNE_TASK_PROMPT: input.task.prompt
    }
  });

  const verification: CommandExecution[] = [];
  for (const command of input.config.verification.commands) {
    verification.push(await runShellCommand({
      command,
      cwd: input.cwd,
      timeoutMs: input.config.verification.timeout_ms,
      env: {
        ARIADNE_TASK_ID: input.task.id,
        ARIADNE_TASK_NAME: input.task.name,
        ARIADNE_TASK_FILE: input.task.file
      }
    }));
  }

  const changedFiles = await getChangedFiles(input.cwd);
  const forbiddenFilesAfter = await snapshotForbiddenFiles(input.cwd, input.config.checks.forbidden_files);
  const diff = await getGitDiff(input.cwd);
  const allLogs = [
    agent.command,
    agent.stdout,
    agent.stderr,
    ...verification.flatMap((result) => [
      result.command,
      result.stdout,
      result.stderr
    ])
  ].join("\n");

  const partial: Omit<TaskRunResult, "score"> = {
    task: input.task,
    agent,
    verification,
    trace: {
      gitAvailable: input.gitAvailable,
      workspaceDirtyBefore,
      changedFiles,
      forbiddenFileChanges: diffForbiddenSnapshots(forbiddenFilesBefore, forbiddenFilesAfter),
      diff,
      diffLineCount: countDiffChangedLines(diff),
      commandsObserved: unique([
        agent.command,
        ...verification.map((result) => result.command),
        ...extractObservedCommands(allLogs)
      ])
    }
  };

  return {
    ...partial,
    score: scoreTaskRun(partial, input.config)
  };
}

export async function runAriadne(options: RunOptions): Promise<AriadneRun & { outputPath: string }> {
  const startedAt = new Date();
  const { config, path: resolvedConfigPath } = await loadConfig(options.cwd, options.configPath);
  const tasks = await loadTasks(options.cwd, config.tasks.directory);
  const gitAvailable = await isGitRepository(options.cwd);
  const results: TaskRunResult[] = [];

  for (const task of tasks) {
    console.log(`Running task: ${task.id}`);
    results.push(await runTask({
      cwd: options.cwd,
      config,
      task,
      gitAvailable
    }));
  }

  const completedAt = new Date();
  const summary = {
    total: results.length,
    passed: results.filter((result) => result.score.passed).length,
    failed: results.filter((result) => !result.score.passed).length
  };
  const run: AriadneRun = {
    version: 1,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
    cwd: options.cwd,
    configPath: resolvedConfigPath,
    config,
    results,
    summary
  };
  const outputPath = path.join(options.cwd, ".ariadne", "runs", `${timestampForFile(startedAt)}.json`);

  await fs.outputJson(outputPath, run, { spaces: 2 });

  return {
    ...run,
    outputPath
  };
}
