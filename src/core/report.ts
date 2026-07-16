import path from "node:path";
import { findLatestRunFile as latestRunFile, loadRunFile } from "./run-reader.js";
import type {
  AnyRunRecord,
  ChangeEvidence,
  LegacyRunRecord,
  LegacyTaskRunResult,
  PolicyResult,
  ProcessCleanupResult,
  ProcessResult,
  RepositoryEntry,
  RunRecord,
  TaskOutcome,
  PromotionRecord
} from "../types/index.js";

export interface ProcessView {
  command: string;
  status: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdoutPreview: string;
  stderrPreview: string;
  stdoutBytes?: number;
  stderrBytes?: number;
  stdoutHadDecodingReplacement?: boolean;
  stderrHadDecodingReplacement?: boolean;
  spawnError?: string;
  cleanup?: ProcessCleanupResult;
  stdoutArtifact?: string;
  stderrArtifact?: string;
}

export interface TaskReportView {
  id: string;
  name: string;
  status: string;
  outcome: string;
  durationMs: number;
  agent?: ProcessView;
  verification: ProcessView[];
  changedFiles: string[];
  preexistingFiles: string[];
  changes: ChangeEvidence[];
  preexistingEntries: RepositoryEntry[];
  diffLineCount: number;
  policies: PolicyResult[];
  score: number;
  failures: string[];
  lifecycle: Array<{ stage: string; at: string; detail?: string }>;
  diffArtifact?: string;
}

export interface RunReportView {
  schemaVersion: number;
  runId: string;
  status: string;
  outcome: string;
  startedAt: string;
  completedAt?: string;
  durationMs: number;
  ariadneVersion?: string;
  environment?: string;
  tasks: TaskReportView[];
  warnings: string[];
  failures: string[];
  lifecycle: Array<{ stage: string; at: string; detail?: string }>;
  manifestPath?: string;
  workflow?: RunRecord["workflow"];
  workspace?: RunRecord["workspace"];
  changeArtifact?: RunRecord["changeArtifact"];
  promotions: PromotionRecord[];
}

function preview(head: string, tail: string): string {
  return head === tail ? head : [head, tail].filter(Boolean).join("\n… output omitted …\n");
}

function processView(result: ProcessResult): ProcessView {
  const status = result.interrupted ? "interrupted" : result.timedOut ? "timeout" : result.spawnError ? "spawn-failed" : result.exitCode === 0 ? "passed" : "failed";
  return {
    command: result.displayCommand,
    status,
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
    stdoutPreview: preview(result.stdoutPreview.head, result.stdoutPreview.tail),
    stderrPreview: preview(result.stderrPreview.head, result.stderrPreview.tail),
    stdoutBytes: result.stdoutPreview.bytes,
    stderrBytes: result.stderrPreview.bytes,
    stdoutHadDecodingReplacement: result.stdoutPreview.hadDecodingReplacement,
    stderrHadDecodingReplacement: result.stderrPreview.hadDecodingReplacement,
    spawnError: result.spawnError,
    cleanup: result.cleanup,
    stdoutArtifact: result.stdoutArtifact,
    stderrArtifact: result.stderrArtifact
  };
}

function legacyOutcome(result: LegacyTaskRunResult): TaskOutcome {
  const value = result.score.status;
  if (value === "timeout") return "timeout";
  if (value === "agent_failed") return "agent_failed";
  if (value === "verification_failed") return "verification_failed";
  if (result.score.passed) return "passed";
  return "policy_failed";
}

function legacyProcess(result: LegacyTaskRunResult["agent"]): ProcessView {
  return {
    command: result.command,
    status: result.timedOut ? "timeout" : result.exitCode === 0 ? "passed" : "failed",
    exitCode: result.exitCode,
    signal: null,
    durationMs: result.runtimeMs,
    stdoutPreview: result.stdout,
    stderrPreview: result.stderr
  };
}

function legacyPolicies(result: LegacyTaskRunResult): PolicyResult[] {
  const mapping: Record<string, PolicyResult["ruleId"]> = {
    forbidden_files: "files.forbidden",
    forbidden_commands: "commands.forbidden",
    max_changed_files: "changes.max-files",
    max_diff_lines: "changes.max-diff-lines"
  };
  return (result.score.checks ?? []).flatMap((check): PolicyResult[] => {
    const ruleId = mapping[check.name];
    return ruleId ? [{ ruleId, outcome: check.passed ? "pass" : "fail", penalty: check.passed ? 0 : 25, summary: check.message, evidence: check.details ?? {} }] : [];
  });
}

export function formatFailureRecord(failure: RunRecord["failures"][number]): string {
  const diagnostic = failure.details?.diagnostic && typeof failure.details.diagnostic === "object"
    ? failure.details.diagnostic as Record<string, unknown>
    : {};
  const details = [
    `Category: ${failure.category}`,
    failure.source ? `Source: ${failure.source}` : undefined,
    typeof diagnostic.fieldPath === "string" ? `Field: ${diagnostic.fieldPath}` : undefined,
    typeof diagnostic.offendingValue === "string" ? `Value: ${diagnostic.offendingValue}` : undefined,
    typeof diagnostic.expected === "string" ? `Expected: ${diagnostic.expected}` : undefined,
    typeof diagnostic.correction === "string" ? `Correction: ${diagnostic.correction}` : undefined
  ].filter((value): value is string => Boolean(value));
  return [`[${failure.code}] ${failure.message}`, ...details].join(" ");
}

function currentView(run: RunRecord, warnings: string[], manifestPath?: string): RunReportView {
  return {
    schemaVersion: run.schemaVersion,
    runId: run.runId,
    status: run.status,
    outcome: run.summary.outcome,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    durationMs: run.durationMs ?? 0,
    ariadneVersion: run.ariadneVersion,
    environment: `${run.environment.platform} ${run.environment.release} ${run.environment.arch}, ${run.environment.node}`,
    warnings: [...run.compatibilityWarnings, ...warnings],
    failures: run.failures.map(formatFailureRecord),
    lifecycle: run.lifecycle,
    manifestPath,
    workflow: run.workflow,
    workspace: run.workspace,
    changeArtifact: run.changeArtifact,
    promotions: [],
    tasks: run.results.map((result) => ({
      id: result.task.id,
      name: result.task.name,
      status: result.status,
      outcome: result.outcome,
      durationMs: result.durationMs,
      agent: result.agent ? processView(result.agent) : undefined,
      verification: result.verification.flatMap((item) => item.command ? [processView(item.command)] : [{ command: item.displayCommand, status: "skipped", exitCode: null, signal: null, durationMs: 0, stdoutPreview: "", stderrPreview: item.skipReason ?? "" }]),
      changedFiles: result.trace?.taskChanges.map((change) => change.path) ?? [],
      preexistingFiles: result.trace?.preexistingChanges.map((entry) => entry.path) ?? [],
      changes: result.trace?.taskChanges ?? [],
      preexistingEntries: result.trace?.preexistingChanges ?? [],
      diffLineCount: result.trace?.diffLineCount ?? 0,
      policies: result.policies,
      score: result.score.value,
      failures: result.failures.map(formatFailureRecord),
      lifecycle: result.lifecycle,
      diffArtifact: result.trace?.diffArtifact
    }))
  };
}

function legacyView(run: LegacyRunRecord, warnings: string[], manifestPath?: string): RunReportView {
  const results = run.results ?? [];
  const tasks = results.map((result): TaskReportView => {
    const policies = legacyPolicies(result);
    return {
      id: result.task.id,
      name: result.task.name,
      status: result.score.passed ? "passed" : "failed",
      outcome: legacyOutcome(result),
      durationMs: result.durationMs ?? result.agent.runtimeMs + result.verification.reduce((sum, item) => sum + item.runtimeMs, 0),
      agent: legacyProcess(result.agent),
      verification: result.verification.map(legacyProcess),
      changedFiles: result.trace?.changedFiles ?? [],
      preexistingFiles: result.trace?.workspaceDirtyBefore ?? [],
      changes: (result.trace?.changedFiles ?? []).map((filePath) => ({ path: filePath, changeType: "modified", source: "agent" })),
      preexistingEntries: (result.trace?.workspaceDirtyBefore ?? []).map((filePath) => ({ path: filePath, indexStatus: "?", worktreeStatus: "?", changeType: "modified" })),
      diffLineCount: result.trace?.diffLineCount ?? 0,
      policies,
      score: Math.max(0, 100 - policies.filter((policy) => policy.outcome === "fail").reduce((sum, policy) => sum + policy.penalty, 0)),
      failures: (result.score.checks ?? []).filter((check) => !check.passed).map((check) => check.message),
      lifecycle: [],
      diffArtifact: undefined
    };
  });
  const failed = tasks.filter((task) => task.outcome !== "passed");
  return {
    schemaVersion: run.schemaVersion ?? run.version ?? 1,
    runId: manifestPath ? path.basename(manifestPath, ".json") : run.startedAt,
    status: failed.length > 0 ? "failed" : "completed",
    outcome: failed[0]?.outcome ?? "passed",
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    durationMs: run.durationMs ?? 0,
    warnings,
    failures: [],
    lifecycle: [],
    manifestPath,
    tasks,
    promotions: []
  };
}

export function buildReportModel(run: AnyRunRecord, warnings: string[] = [], manifestPath?: string): RunReportView {
  return "runId" in run ? currentView(run, warnings, manifestPath) : legacyView(run, warnings, manifestPath);
}

export async function findLatestRunFile(cwd: string): Promise<string> {
  return latestRunFile(cwd);
}

export async function loadRunReport(runPath: string): Promise<RunReportView> {
  const loaded = await loadRunFile(runPath);
  if (!loaded.ok) throw new Error(loaded.error);
  return buildReportModel(loaded.run, loaded.warnings, runPath);
}

function duration(value: number): string {
  if (value < 1000) return `${value}ms`;
  const seconds = Math.round(value / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function formatRunCompletion(run: RunRecord & { outputPath?: string }): string {
  const model = buildReportModel(run, [], run.outputPath);
  const lines = ["Ariadne run completed", `Run: ${model.runId}`, `Status: ${model.status}`, `Outcome: ${model.outcome}`, `Duration: ${duration(model.durationMs)}`];
  for (const task of model.tasks) {
    const verificationStatuses = [...new Set(task.verification.map((item) => item.status))];
    const verificationStatus = verificationStatuses.length === 0 ? "none" : verificationStatuses.join(", ");
    lines.push("", `Task: ${task.name}`, `  outcome: ${task.outcome}`, `  agent: ${task.agent?.status ?? "not-run"}`, `  verification: ${verificationStatus}`, `  policy score: ${task.score}`, `  changed files: ${task.changedFiles.length}`, `  diff lines: ${task.diffLineCount}`);
  }
  for (const warning of model.warnings) lines.push(`Warning: ${warning}`);
  for (const runFailure of model.failures) lines.push(`Failure: ${runFailure}`);
  if (run.outputPath) lines.push(`Manifest: ${path.relative(process.cwd(), run.outputPath) || run.outputPath}`);
  return lines.join("\n");
}

export function formatTerminalSummary(model: RunReportView): string {
  const lines = [`Ariadne run: ${model.runId}`, `Status: ${model.status}`, `Outcome: ${model.outcome}`, `Duration: ${duration(model.durationMs)}`, `Tasks: ${model.tasks.length}`, `Run schema: ${model.schemaVersion}`];
  if (model.workflow) lines.push(`Batch: ${model.workflow.batchId}`, `Attempt: ${model.workflow.attempt}`);
  if (model.workspace) lines.push(`Isolation: ${model.workspace.strategy}`, `Workspace: ${model.workspace.workspaceId} (${model.workspace.state})`);
  if (model.changeArtifact) lines.push(`Change artifact: ${model.changeArtifact.state}`, `Applicable: ${model.changeArtifact.applicable ? "yes" : "no"}`, `Result revision: ${model.changeArtifact.resultRevision ?? "none"}`);
  if (model.promotions.length > 0) lines.push(`Promotions: ${model.promotions.map((item) => `${item.kind}:${item.status}`).join(", ")}`);
  for (const warning of model.warnings) lines.push(`Warning: ${warning}`);
  for (const task of model.tasks) {
    lines.push("", `${task.outcome.toUpperCase()} ${task.id} - ${task.name}`, `  Agent: ${task.agent?.status ?? "not-run"}`, `  Verification: ${task.verification.map((item) => item.status).join(", ") || "none"}`, `  Policy score: ${task.score}`, `  Changed files: ${task.changedFiles.length}, diff lines: ${task.diffLineCount}`);
    for (const failure of task.failures) lines.push(`  ${failure}`);
  }
  return lines.join("\n");
}

function escapeHtml(value: unknown): string {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function processHtml(title: string, process: ProcessView | undefined): string {
  if (!process) return `<section><h3>${escapeHtml(title)}</h3><p>Not run.</p></section>`;
  const cleanup = process.cleanup ? JSON.stringify(process.cleanup, null, 2) : "Legacy cleanup metadata unavailable";
  return `<section><h3>${escapeHtml(title)}</h3><dl><dt>Command</dt><dd><code>${escapeHtml(process.command)}</code></dd><dt>Status</dt><dd>${escapeHtml(process.status)}</dd><dt>Exit / signal</dt><dd>${escapeHtml(process.exitCode)} / ${escapeHtml(process.signal ?? "none")}</dd><dt>Duration</dt><dd>${escapeHtml(duration(process.durationMs))}</dd><dt>stdout bytes / replacement</dt><dd>${escapeHtml(process.stdoutBytes ?? "legacy")} / ${escapeHtml(process.stdoutHadDecodingReplacement ?? "unknown")}</dd><dt>stderr bytes / replacement</dt><dd>${escapeHtml(process.stderrBytes ?? "legacy")} / ${escapeHtml(process.stderrHadDecodingReplacement ?? "unknown")}</dd>${process.spawnError ? `<dt>Spawn error</dt><dd>${escapeHtml(process.spawnError)}</dd>` : ""}</dl><details><summary>stdout preview</summary><pre>${escapeHtml(process.stdoutPreview || "No output")}</pre></details><details><summary>stderr preview</summary><pre>${escapeHtml(process.stderrPreview || "No output")}</pre></details><details><summary>Cleanup</summary><pre>${escapeHtml(cleanup)}</pre></details>${process.stdoutArtifact ? `<p>Full stdout: <code>${escapeHtml(process.stdoutArtifact)}</code></p>` : ""}${process.stderrArtifact ? `<p>Full stderr: <code>${escapeHtml(process.stderrArtifact)}</code></p>` : ""}</section>`;
}

export function buildHtmlReport(model: RunReportView): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ariadne report ${escapeHtml(model.runId)}</title>
<style>body{margin:0;background:#f6f7f4;color:#1e241f;font:15px/1.55 system-ui,sans-serif}main{max-width:1050px;margin:auto;padding:36px 20px}h1{font-size:2rem}h2{margin-top:2.5rem}.summary,.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.card,section{background:#fff;border:1px solid #d8ddd5;border-radius:8px;padding:16px;margin-top:12px}.card strong,dt{display:block;color:#5c685e;font-size:.78rem;text-transform:uppercase}dd{margin:0 0 8px}pre{overflow:auto;white-space:pre-wrap;background:#111711;color:#edf3ed;padding:12px;border-radius:6px}.fail{border-left:5px solid #b42318}.pass{border-left:5px solid #18794e}table{width:100%;border-collapse:collapse}th,td{text-align:left;border-bottom:1px solid #ddd;padding:8px}code{overflow-wrap:anywhere}@media print{body{background:#fff}details{display:block}section,.card{break-inside:avoid}}</style></head><body><main>
<header><h1>Ariadne Reliability Report</h1><p>Run ${escapeHtml(model.runId)}</p>${model.workflow ? `<p>Parent batch: ${escapeHtml(model.workflow.batchId)}; attempt ${escapeHtml(model.workflow.attempt)}</p>` : ""}<div class="summary"><div class="card"><strong>Status</strong>${escapeHtml(model.status)}</div><div class="card"><strong>Outcome</strong>${escapeHtml(model.outcome)}</div><div class="card"><strong>Duration</strong>${escapeHtml(duration(model.durationMs))}</div><div class="card"><strong>Schema</strong>${escapeHtml(model.schemaVersion)}</div></div></header>
${model.warnings.map((warning) => `<p class="card fail"><strong>Warning</strong>${escapeHtml(warning)}</p>`).join("")}
${model.workspace ? `<section><h2>Workspace isolation</h2><dl><dt>Strategy</dt><dd>${escapeHtml(model.workspace.strategy)}</dd><dt>Workspace</dt><dd>${escapeHtml(model.workspace.workspaceId)} (${escapeHtml(model.workspace.state)})</dd><dt>Source revision</dt><dd><code>${escapeHtml(model.workspace.sourceRevision ?? "unavailable")}</code></dd><dt>Prepared revision</dt><dd><code>${escapeHtml(model.workspace.preparedRevision ?? "unavailable")}</code></dd><dt>Dirty source acknowledged</dt><dd>${escapeHtml(model.workspace.dirtyBaseAcknowledged)}</dd><dt>Retention</dt><dd>${escapeHtml(model.workspace.retention)}${model.workspace.retentionReason ? ` — ${escapeHtml(model.workspace.retentionReason)}` : ""}</dd><dt>Inherited results</dt><dd><pre>${escapeHtml(JSON.stringify(model.workspace.inheritedResults, null, 2))}</pre></dd></dl>${model.workspace.preparation.map((item, index) => processHtml(`Preparation ${index + 1}`, processView(item))).join("")}</section>` : ""}
${model.changeArtifact ? `<section><h2>Durable change artifact</h2><dl><dt>State</dt><dd>${escapeHtml(model.changeArtifact.state)}</dd><dt>Applicable</dt><dd>${escapeHtml(model.changeArtifact.applicable)}</dd><dt>Result revision</dt><dd><code>${escapeHtml(model.changeArtifact.resultRevision ?? "none")}</code></dd><dt>Result ref</dt><dd><code>${escapeHtml(model.changeArtifact.resultRef ?? "none")}</code></dd><dt>Patch</dt><dd><code>${escapeHtml(model.changeArtifact.patchArtifact ?? "none")}</code></dd><dt>Preview</dt><dd><code>${escapeHtml(model.changeArtifact.previewArtifact ?? "none")}</code></dd>${model.changeArtifact.ineligibleReason ? `<dt>Ineligible reason</dt><dd>${escapeHtml(model.changeArtifact.ineligibleReason)}</dd>` : ""}</dl><h3>Captured changes</h3><pre>${escapeHtml(JSON.stringify(model.changeArtifact.changes, null, 2))}</pre><h3>Omitted sensitive paths</h3><pre>${escapeHtml(JSON.stringify(model.changeArtifact.omittedSensitive, null, 2))}</pre></section>` : ""}
${model.promotions.length > 0 ? `<section><h2>Promotion history</h2><table><thead><tr><th>ID</th><th>Kind</th><th>Status</th><th>Target</th><th>Pre/post revisions</th><th>Conflicts</th></tr></thead><tbody>${model.promotions.map((item) => `<tr><td>${escapeHtml(item.promotionId)}</td><td>${escapeHtml(item.kind)}</td><td>${escapeHtml(item.status)}</td><td>${escapeHtml(item.targetBranch ?? "")}</td><td><code>${escapeHtml(item.preApplyRevision ?? "")} / ${escapeHtml(item.postApplyRevision ?? "")}</code></td><td>${escapeHtml(item.conflictPaths.join(", "))}</td></tr>`).join("")}</tbody></table></section>` : ""}
<section><h2>Run lifecycle</h2><table><thead><tr><th>Stage</th><th>Time</th><th>Detail</th></tr></thead><tbody>${model.lifecycle.map((event) => `<tr><td>${escapeHtml(event.stage)}</td><td>${escapeHtml(event.at)}</td><td>${escapeHtml(event.detail ?? "")}</td></tr>`).join("") || "<tr><td colspan=3>Legacy run lifecycle unavailable</td></tr>"}</tbody></table></section>
<section><h2>Run failures</h2><pre>${escapeHtml(model.failures.join("\n") || "None")}</pre></section>
${model.tasks.map((task) => `<article class="card ${task.outcome === "passed" ? "pass" : "fail"}"><h2>${escapeHtml(task.id)} — ${escapeHtml(task.name)}</h2><div class="grid"><div><strong>Outcome</strong>${escapeHtml(task.outcome)}</div><div><strong>Duration</strong>${escapeHtml(duration(task.durationMs))}</div><div><strong>Policy score</strong>${escapeHtml(task.score)}</div><div><strong>Changed files</strong>${escapeHtml(task.changedFiles.length)}</div><div><strong>Diff lines</strong>${escapeHtml(task.diffLineCount)}</div></div>
<section><h3>Lifecycle</h3><table><thead><tr><th>Stage</th><th>Time</th><th>Detail</th></tr></thead><tbody>${task.lifecycle.map((event) => `<tr><td>${escapeHtml(event.stage)}</td><td>${escapeHtml(event.at)}</td><td>${escapeHtml(event.detail ?? "")}</td></tr>`).join("") || "<tr><td colspan=3>Legacy lifecycle unavailable</td></tr>"}</tbody></table></section>
${processHtml("Agent", task.agent)}${task.verification.map((item, index) => processHtml(`Verification ${index + 1}`, item)).join("")}
<section><h3>Repository changes</h3><h4>Task-attributed changes</h4><table><thead><tr><th>Path</th><th>Change</th><th>Source</th></tr></thead><tbody>${task.changes.map((change) => `<tr><td>${escapeHtml(change.path)}</td><td>${escapeHtml(change.changeType)}</td><td>${escapeHtml(change.source)}</td></tr>`).join("") || "<tr><td colspan=3>None</td></tr>"}</tbody></table><h4>Preexisting baseline dirt</h4><table><thead><tr><th>Path</th><th>State</th><th>Index / worktree</th><th>Mode</th></tr></thead><tbody>${task.preexistingEntries.map((entry) => `<tr><td>${escapeHtml(entry.path)}</td><td>${escapeHtml(entry.changeType)}</td><td>${escapeHtml(entry.indexStatus)} / ${escapeHtml(entry.worktreeStatus)}</td><td>${escapeHtml(entry.mode ?? "unknown")}</td></tr>`).join("") || "<tr><td colspan=4>None</td></tr>"}</tbody></table>${task.diffArtifact ? `<p>Full diff: <code>${escapeHtml(task.diffArtifact)}</code></p>` : ""}</section>
<section><h3>Policy results and score breakdown</h3><p>Policy score: ${escapeHtml(task.score)} / 100</p><table><thead><tr><th>Rule</th><th>Outcome</th><th>Penalty</th><th>Summary</th><th>Evidence</th></tr></thead><tbody>${task.policies.map((policy) => `<tr><td>${escapeHtml(policy.ruleId)}</td><td>${escapeHtml(policy.outcome)}</td><td>${escapeHtml(policy.penalty)}</td><td>${escapeHtml(policy.summary)}</td><td><details><summary>View</summary><pre>${escapeHtml(JSON.stringify(policy.evidence, null, 2))}</pre></details></td></tr>`).join("") || "<tr><td colspan=5>No policy results</td></tr>"}</tbody></table></section>
<section><h3>Failures</h3><pre>${escapeHtml(task.failures.join("\n") || "None")}</pre></section></article>`).join("")}
<footer><p>Environment: ${escapeHtml(model.environment ?? "Legacy environment unavailable")}</p><p>Ariadne is an observability and policy tool, not a security sandbox.</p></footer></main></body></html>`;
}
