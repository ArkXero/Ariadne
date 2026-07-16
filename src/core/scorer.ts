import { findForbiddenObservedCommandMatches } from "./forbidden-commands.js";
import type { AriadneConfig, PolicyResult, RepositoryTrace, ScoreBreakdown, WorkspaceMode } from "../types/index.js";

const PENALTIES: Record<PolicyResult["ruleId"], number> = {
  "files.forbidden": 40,
  "commands.forbidden": 30,
  "changes.max-files": 15,
  "changes.max-diff-lines": 15,
  "workspace.read-only": 100
};

export function evaluatePolicies(trace: RepositoryTrace | undefined, config: AriadneConfig, workspaceMode: WorkspaceMode = "mutable"): PolicyResult[] {
  if (!trace) {
    return (Object.keys(PENALTIES) as PolicyResult["ruleId"][]).map((ruleId) => ({
      ruleId,
      outcome: "not-applicable",
      penalty: 0,
      summary: "Policy could not be evaluated because repository trace is unavailable.",
      evidence: {}
    }));
  }

  const filePolicy: PolicyResult = config.checks.forbidden_files.length === 0
    ? { ruleId: "files.forbidden", outcome: "not-applicable", penalty: 0, summary: "No forbidden file patterns configured.", evidence: {} }
    : trace.forbiddenFileChanges.length > 0
      ? { ruleId: "files.forbidden", outcome: "fail", penalty: PENALTIES["files.forbidden"], summary: "Forbidden files changed.", evidence: { changes: trace.forbiddenFileChanges } }
      : { ruleId: "files.forbidden", outcome: "pass", penalty: 0, summary: "No forbidden files changed.", evidence: { patterns: config.checks.forbidden_files } };

  const commandMatches = findForbiddenObservedCommandMatches(config.checks.forbidden_commands, trace.observedCommands);
  const executedMatches = commandMatches.filter((match) => match.confidence === "executed" || match.confidence === "blocked");
  const reportedMatches = commandMatches.filter((match) => match.confidence === "reported");
  const commandPolicy: PolicyResult = config.checks.forbidden_commands.length === 0
    ? { ruleId: "commands.forbidden", outcome: "not-applicable", penalty: 0, summary: "No forbidden command rules configured.", evidence: {} }
    : executedMatches.length > 0
      ? { ruleId: "commands.forbidden", outcome: "fail", penalty: PENALTIES["commands.forbidden"], summary: "A directly launched command matched a forbidden rule.", evidence: { matches: executedMatches, reportedMatches } }
      : reportedMatches.length > 0
        ? { ruleId: "commands.forbidden", outcome: "warning", penalty: 0, summary: "Agent output reported a forbidden command, but output is not proof of execution.", evidence: { reportedMatches } }
        : { ruleId: "commands.forbidden", outcome: "pass", penalty: 0, summary: "No observable command matched a forbidden rule.", evidence: { rules: config.checks.forbidden_commands } };

  const changedFilesPolicy: PolicyResult = config.checks.max_changed_files === undefined
    ? { ruleId: "changes.max-files", outcome: "not-applicable", penalty: 0, summary: "No changed-file limit configured.", evidence: {} }
    : trace.taskChanges.length > config.checks.max_changed_files
      ? { ruleId: "changes.max-files", outcome: "fail", penalty: PENALTIES["changes.max-files"], summary: "Task-caused changed-file count exceeds the configured limit.", evidence: { count: trace.taskChanges.length, limit: config.checks.max_changed_files, files: trace.taskChanges.map((change) => change.path) } }
      : { ruleId: "changes.max-files", outcome: "pass", penalty: 0, summary: "Task-caused changed-file count is within the configured limit.", evidence: { count: trace.taskChanges.length, limit: config.checks.max_changed_files } };

  const diffPolicy: PolicyResult = config.checks.max_diff_lines === undefined
    ? { ruleId: "changes.max-diff-lines", outcome: "not-applicable", penalty: 0, summary: "No diff-line limit configured.", evidence: {} }
    : trace.diffLineCount > config.checks.max_diff_lines
      ? { ruleId: "changes.max-diff-lines", outcome: "fail", penalty: PENALTIES["changes.max-diff-lines"], summary: "Task-caused diff line count exceeds the configured limit.", evidence: { count: trace.diffLineCount, limit: config.checks.max_diff_lines } }
      : { ruleId: "changes.max-diff-lines", outcome: "pass", penalty: 0, summary: "Task-caused diff line count is within the configured limit.", evidence: { count: trace.diffLineCount, limit: config.checks.max_diff_lines } };

  const readOnlyPolicy: PolicyResult = workspaceMode === "mutable"
    ? { ruleId: "workspace.read-only", outcome: "not-applicable", penalty: 0, summary: "Task workspace is mutable.", evidence: {} }
    : trace.taskChanges.length > 0
      ? { ruleId: "workspace.read-only", outcome: "fail", penalty: PENALTIES["workspace.read-only"], summary: "A read-only task produced Git-visible repository changes.", evidence: { changes: trace.taskChanges } }
      : { ruleId: "workspace.read-only", outcome: "pass", penalty: 0, summary: "Read-only task produced no Git-visible repository changes.", evidence: {} };

  return [filePolicy, commandPolicy, changedFilesPolicy, diffPolicy, readOnlyPolicy];
}

export function scorePolicies(policies: PolicyResult[]): ScoreBreakdown {
  const deductions = [...new Map(
    policies.filter((policy) => policy.outcome === "fail" && policy.penalty > 0).map((policy) => [policy.ruleId, { ruleId: policy.ruleId, penalty: policy.penalty }])
  ).values()].sort((left, right) => left.ruleId.localeCompare(right.ruleId));
  const value = Math.max(0, Math.min(100, 100 - deductions.reduce((total, deduction) => total + deduction.penalty, 0)));
  return { value, minimum: 0, maximum: 100, basis: "policy", deductions };
}
