import { matchesFilePattern } from "./path-match.js";
import type { AriadneConfig, ScoreCheck, TaskRunResult } from "../types/index.js";

function failedCheck(name: string, message: string, details?: Record<string, unknown>): ScoreCheck {
  return { name, passed: false, message, details };
}

function passedCheck(name: string, message: string, details?: Record<string, unknown>): ScoreCheck {
  return { name, passed: true, message, details };
}

export function scoreTaskRun(result: Omit<TaskRunResult, "score">, config: AriadneConfig): TaskRunResult["score"] {
  const checks: ScoreCheck[] = [];

  checks.push(
    result.agent.exitCode === 0
      ? passedCheck("agent_exit_code", "Agent command exited with code 0.")
      : failedCheck("agent_exit_code", `Agent command exited with code ${result.agent.exitCode}.`)
  );

  const failedVerification = result.verification.filter((commandResult) => commandResult.exitCode !== 0);
  checks.push(
    failedVerification.length === 0
      ? passedCheck("verification", "All verification commands passed.", { commands: result.verification.map((item) => item.command) })
      : failedCheck("verification", "One or more verification commands failed.", {
        failedCommands: failedVerification.map((item) => ({
          command: item.command,
          exitCode: item.exitCode
        }))
      })
  );

  const forbiddenFilesFromGit = result.trace.changedFiles.filter((filePath) => {
    return config.checks.forbidden_files.some((pattern) => matchesFilePattern(filePath, pattern));
  });
  const forbiddenFiles = [...new Set([
    ...forbiddenFilesFromGit,
    ...result.trace.forbiddenFileChanges
  ])].sort();

  checks.push(
    forbiddenFiles.length === 0
      ? passedCheck("forbidden_files", "No forbidden files were modified.", { patterns: config.checks.forbidden_files })
      : failedCheck("forbidden_files", "Forbidden files were modified.", { files: forbiddenFiles })
  );

  if (config.checks.max_changed_files !== undefined) {
    const changedCount = result.trace.changedFiles.length;
    checks.push(
      changedCount <= config.checks.max_changed_files
        ? passedCheck("max_changed_files", "Changed file count is within limit.", {
          count: changedCount,
          limit: config.checks.max_changed_files
        })
        : failedCheck("max_changed_files", "Changed file count exceeds limit.", {
          count: changedCount,
          limit: config.checks.max_changed_files
        })
    );
  }

  if (config.checks.max_diff_lines !== undefined) {
    checks.push(
      result.trace.diffLineCount <= config.checks.max_diff_lines
        ? passedCheck("max_diff_lines", "Diff line count is within limit.", {
          count: result.trace.diffLineCount,
          limit: config.checks.max_diff_lines
        })
        : failedCheck("max_diff_lines", "Diff line count exceeds limit.", {
          count: result.trace.diffLineCount,
          limit: config.checks.max_diff_lines
        })
    );
  }

  const logs = [
    result.agent.command,
    result.agent.stdout,
    result.agent.stderr,
    ...result.verification.flatMap((commandResult) => [
      commandResult.command,
      commandResult.stdout,
      commandResult.stderr
    ]),
    ...result.trace.commandsObserved
  ].join("\n");
  const forbiddenCommands = config.checks.forbidden_commands.filter((command) => logs.includes(command));
  checks.push(
    forbiddenCommands.length === 0
      ? passedCheck("forbidden_commands", "No forbidden command strings were observed.", {
        patterns: config.checks.forbidden_commands
      })
      : failedCheck("forbidden_commands", "Forbidden command strings appeared in logs or observed commands.", {
        commands: forbiddenCommands
      })
  );

  return {
    passed: checks.every((check) => check.passed),
    checks
  };
}
