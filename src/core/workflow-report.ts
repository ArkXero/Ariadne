import type { BatchRecord, BenchmarkResult, PromotionRecord, WorkflowPlan } from "../types/index.js";
import { ARIADNE_CSS_VARIABLES } from "../theme.js";
import { formatFailureRecord } from "./report.js";

function duration(value: number): string {
  if (value < 1000) return `${value}ms`;
  const seconds = Math.round(value / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function formatWorkflowPlan(plan: WorkflowPlan): string {
  const lines = [
    "Ariadne workflow plan",
    `Plan: ${plan.planId}`,
    `Selected roots: ${plan.selectedRoots.join(", ")}`,
    `Included tasks: ${plan.includedTasks.length}`,
    `Concurrency: ${plan.concurrency}`,
    `Isolation: ${plan.isolation}`,
    `Failure mode: ${plan.failureMode}`
  ];
  for (const [index, level] of plan.levels.entries()) lines.push(`Level ${index}: ${level.join(", ")}`);
  for (const [index, group] of plan.concurrencyGroups.entries()) lines.push(`Possible group ${index + 1}: ${group.join(", ")}`);
  lines.push("", "ORDER  TASK  DEPENDENCIES  WORKSPACE  RETRY");
  for (const task of plan.tasks) lines.push(`${String(task.order + 1).padEnd(5)}  ${task.id}  ${task.dependencies.join(", ") || "none"}  ${task.workspaceMode}  ${task.retry.attempts}`);
  return lines.join("\n");
}

export function formatWorkflowPlanGuide(): string {
  return [
    "How to read this plan (shown once)",
    "  Plan             Identifier for this exact workflow.",
    "  Selected roots   Tasks you asked Ariadne to plan.",
    "  Included tasks   Selected tasks plus their dependencies.",
    "  Concurrency      Maximum tasks that may run together.",
    "  Isolation        Separate Git folders or this project folder.",
    "  Failure mode     Whether unrelated tasks continue after a failure.",
    "  Levels/groups    Tasks that become ready at the same stage.",
    "  Order            Planned task order.",
    "  Dependencies     Tasks that must finish first.",
    "  Workspace        mutable can edit files; read-only cannot.",
    "  Retry            Total attempts (3 = 1 try + 2 retries).",
    "",
    "This is only a preview. No tasks have run yet."
  ].join("\n");
}

export interface BatchReportView {
  kind: "batch";
  schemaVersion: number;
  runId: string;
  batchId: string;
  status: BatchRecord["status"];
  outcome: string;
  batchStatus: string;
  startedAt: string;
  completedAt?: string;
  durationMs: number;
  concurrency: number;
  failureMode: string;
  isolation: string;
  retention: string;
  selectedRoots: string[];
  graph: {
    planId?: string;
    edges: Array<{ from: string; to: string }>;
    levels: string[][];
    concurrencyGroups: string[][];
    order: string[];
  };
  configFingerprint?: string;
  sourceHead?: string;
  environment: string;
  score: number | null;
  tasks: Array<{
    id: string;
    name: string;
    dependencies: string[];
    workspaceMode: string;
    retryLimit: number;
    status: string;
    outcome: string;
    attempts: number;
    finalAttempt?: number;
    durationMs: number;
    score: number | null;
    runId?: string;
    manifest?: string;
    blockedBy?: string;
    blocking?: string;
    warnings: string[];
    history: BatchRecord["tasks"][number]["attempts"];
    workspaceId?: string;
    resultRevision?: string;
    applicable?: boolean;
  }>;
  summary: BatchRecord["summary"];
  warnings: string[];
  failures: string[];
  lifecycle: BatchRecord["lifecycle"];
  relation?: BatchRecord["relation"];
  benchmark?: BenchmarkResult;
  manifestPath?: string;
  promotions: PromotionRecord[];
}

export function buildBatchReportModel(batch: BatchRecord, warnings: string[] = [], manifestPath?: string, promotions: PromotionRecord[] = []): BatchReportView {
  const tasks = batch.tasks.map((task) => {
    const final = task.finalAttempt === undefined ? undefined : task.attempts.find((attempt) => attempt.attempt === task.finalAttempt);
    return {
      id: task.id,
      name: task.name,
      dependencies: task.dependencies,
      workspaceMode: task.workspaceMode,
      retryLimit: task.retry.attempts,
      status: task.state,
      outcome: task.finalOutcome ?? final?.outcome ?? task.blockReason?.outcome ?? (task.state === "interrupted" ? "interrupted" : task.state === "incomplete" ? "internal_failed" : "not_run"),
      attempts: task.attempts.length,
      finalAttempt: task.finalAttempt,
      durationMs: task.attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0),
      score: final?.score ?? null,
      runId: final?.runId,
      manifest: final?.manifest,
      blockedBy: task.blockReason?.dependencyId,
      blocking: task.blockReason ? `${task.blockReason.message} Chain: ${task.blockReason.chain.join(" -> ")}.` : undefined,
      warnings: task.warnings,
      history: task.attempts,
      workspaceId: final?.workspaceId,
      resultRevision: final?.resultRevision,
      applicable: final?.applicable
    };
  });
  return {
    kind: "batch",
    schemaVersion: batch.schemaVersion,
    runId: batch.batchId,
    batchId: batch.batchId,
    status: batch.status,
    outcome: batch.summary.outcome,
    batchStatus: batch.batchStatus,
    startedAt: batch.startedAt,
    completedAt: batch.completedAt,
    durationMs: batch.durationMs ?? 0,
    concurrency: batch.plan?.concurrency ?? 1,
    failureMode: batch.plan?.failureMode ?? "continue",
    isolation: batch.plan?.isolation ?? "shared",
    retention: batch.plan?.retention ?? "on-failure",
    selectedRoots: batch.plan?.selectedRoots ?? [],
    graph: { planId: batch.plan?.planId, edges: batch.plan?.edges ?? [], levels: batch.plan?.levels ?? [], concurrencyGroups: batch.plan?.concurrencyGroups ?? [], order: batch.plan?.order ?? [] },
    configFingerprint: batch.configFingerprint,
    sourceHead: batch.sourceHead,
    environment: `${batch.environment.platform} ${batch.environment.release} ${batch.environment.arch}; Node ${batch.environment.node}; Ariadne ${batch.ariadneVersion}`,
    score: batch.summary.score,
    tasks,
    summary: batch.summary,
    warnings: [...batch.warnings, ...warnings],
    failures: batch.failures.map(formatFailureRecord),
    lifecycle: batch.lifecycle,
    relation: batch.relation,
    benchmark: batch.benchmark,
    manifestPath,
    promotions
  };
}

export function formatBatchCompletion(batch: BatchRecord): string {
  const model = buildBatchReportModel(batch);
  const lines = [
    "Ariadne workflow completed",
    `Batch: ${model.batchId}`,
    `Status: ${model.status}`,
    `Batch status: ${model.batchStatus}`,
    `Outcome: ${model.outcome}`,
    `Duration: ${duration(model.durationMs)}`,
    `Concurrency: ${model.concurrency}`,
    `Isolation: ${model.isolation}`,
    `Policy score: ${model.score ?? "n/a"}`,
    ...(model.benchmark ? [`Benchmark raw score: ${model.benchmark.rawScore ?? "n/a"}`, `Benchmark effective score: ${model.benchmark.effectiveScore ?? "n/a"}`, `Qualification: ${model.benchmark.qualification}`] : []),
    `Plan: ${model.graph.planId ?? "unavailable"}`,
    "",
    "TASK  STATUS  DEPENDENCIES  MODE  ATTEMPTS  DURATION  POLICY SCORE"
  ];
  for (const task of model.tasks) lines.push(`${task.id}  ${task.status}  ${task.dependencies.join(",") || "none"}  ${task.workspaceMode}  ${task.attempts}  ${duration(task.durationMs)}  ${task.score ?? "n/a"}`);
  for (const [index, level] of model.graph.levels.entries()) lines.push(`Level ${index}: ${level.join(", ")}`);
  for (const [index, group] of model.graph.concurrencyGroups.entries()) lines.push(`Possible group ${index + 1}: ${group.join(", ")}`);
  for (const warning of model.warnings) lines.push(`Warning: ${warning}`);
  for (const failure of model.failures) lines.push(`Failure: ${failure}`);
  lines.push(`Manifest: ${batch.artifacts.manifest}`);
  return lines.join("\n");
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

export function buildBatchHtmlReport(model: BatchReportView): string {
  const graphRows = model.tasks.map((task) => `<tr><td>${escapeHtml(task.id)}</td><td>${escapeHtml(task.dependencies.join(", ") || "none")}</td><td>${escapeHtml(task.workspaceMode)}</td><td>${escapeHtml(task.status)}</td><td>${escapeHtml(task.attempts)}</td><td>${escapeHtml(duration(task.durationMs))}</td><td>${escapeHtml(task.score ?? "n/a")}</td><td>${escapeHtml(task.applicable ?? "n/a")}</td><td><code>${escapeHtml(task.resultRevision ?? "")}</code></td><td>${escapeHtml(task.blockedBy ?? "")}</td><td>${task.manifest ? `<code>${escapeHtml(task.manifest)}</code>` : "—"}</td></tr>`).join("");
  const attempts = model.tasks.map((task) => `<section><h2>${escapeHtml(task.id)} — ${escapeHtml(task.name)}</h2><p>Status: ${escapeHtml(task.status)}. Final outcome: ${escapeHtml(task.outcome)}. Retry limit: ${escapeHtml(task.retryLimit)}.</p><table><thead><tr><th>Attempt</th><th>Outcome</th><th>Duration</th><th>Policy score</th><th>Retry decision</th><th>Delay</th><th>Child manifest</th></tr></thead><tbody>${task.history.map((attempt) => `<tr><td>${escapeHtml(attempt.attempt)}</td><td>${escapeHtml(attempt.outcome)}</td><td>${escapeHtml(duration(attempt.durationMs))}</td><td>${escapeHtml(attempt.score)}</td><td>${escapeHtml(attempt.retryReason ?? "none")}</td><td>${escapeHtml(attempt.retryDelayMs ?? "none")}</td><td><code>${escapeHtml(attempt.manifest)}</code></td></tr>`).join("") || "<tr><td colspan=7>Not run</td></tr>"}</tbody></table>${task.blocking ? `<p>${escapeHtml(task.blocking)}</p>` : ""}${task.warnings.map((warning) => `<p class=warning>${escapeHtml(warning)}</p>`).join("")}</section>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ariadne workflow ${escapeHtml(model.batchId)}</title><style>${ARIADNE_CSS_VARIABLES}body{margin:0;background:var(--ariadne-canvas);color:var(--ariadne-report-foreground);font:15px/1.5 system-ui,sans-serif}main{max-width:1100px;margin:auto;padding:32px 20px}h1,h2,h3,a{color:var(--ariadne-accent)}section,.card{background:var(--ariadne-surface);border:1px solid var(--ariadne-border);border-radius:8px;padding:16px;margin:14px 0}table{width:100%;border-collapse:collapse}th,td{text-align:left;border-bottom:1px solid var(--ariadne-border);padding:8px;vertical-align:top}code{overflow-wrap:anywhere}pre{overflow:auto;background:var(--ariadne-code-background);color:var(--ariadne-code-foreground);padding:12px;border-radius:6px}.warning{border-left:4px solid var(--ariadne-warning);color:var(--ariadne-warning);padding-left:10px}@media print{body{background:var(--ariadne-snow)}section{break-inside:avoid}}</style></head><body><main><h1>Ariadne Workflow Report</h1><div class=card><p>Batch: ${escapeHtml(model.batchId)}; plan ${escapeHtml(model.graph.planId ?? "unavailable")}</p><p>Status: ${escapeHtml(model.status)}; batch status ${escapeHtml(model.batchStatus)}; outcome ${escapeHtml(model.outcome)}; policy score ${escapeHtml(model.score ?? "n/a")}</p><p>Duration: ${escapeHtml(duration(model.durationMs))}; concurrency ${escapeHtml(model.concurrency)}; failure mode ${escapeHtml(model.failureMode)}; isolation ${escapeHtml(model.isolation)}; retention ${escapeHtml(model.retention)}</p><p>Selected roots: ${escapeHtml(model.selectedRoots.join(", "))}</p><p>Environment: ${escapeHtml(model.environment)}</p><p>Git HEAD: ${escapeHtml(model.sourceHead ?? "unavailable")}; config fingerprint ${escapeHtml(model.configFingerprint ?? "unavailable")}</p></div>${model.benchmark ? `<section><h2>Professional benchmark score</h2><p>Raw score: ${escapeHtml(model.benchmark.rawScore ?? "n/a")}; effective score: ${escapeHtml(model.benchmark.effectiveScore ?? "n/a")}; qualification: ${escapeHtml(model.benchmark.qualification)}.</p><p>Candidate model: ${escapeHtml(model.benchmark.candidateModel)}; judge model: ${escapeHtml(model.benchmark.judgeModel)}.</p><p>Execution outcome: ${escapeHtml(model.benchmark.executionOutcome)}; policy score: ${escapeHtml(model.benchmark.policyScore)}; benchmark status: ${escapeHtml(model.benchmark.status)}.</p><pre>${escapeHtml(model.benchmark.reason ?? model.benchmark.failure?.message ?? "No explanation")}</pre></section>` : ""}${model.warnings.map((warning) => `<p class="card warning">${escapeHtml(warning)}</p>`).join("")}<section><h2>Workflow graph and task states</h2><table><thead><tr><th>Task</th><th>Dependencies</th><th>Mode</th><th>Status</th><th>Attempts</th><th>Duration</th><th>Score</th><th>Applicable</th><th>Result revision</th><th>Blocked by</th><th>Child manifest</th></tr></thead><tbody>${graphRows}</tbody></table><p>Topological order: ${escapeHtml(model.graph.order.join(" -> "))}</p>${model.graph.levels.map((level, index) => `<p>Level ${escapeHtml(index)}: ${escapeHtml(level.join(", "))}</p>`).join("")}${model.graph.concurrencyGroups.map((group, index) => `<p>Possible concurrency group ${escapeHtml(index + 1)}: ${escapeHtml(group.join(", "))}</p>`).join("")}</section><section><h2>Lifecycle timeline</h2><table><thead><tr><th>Stage</th><th>Task</th><th>Time</th><th>Detail</th></tr></thead><tbody>${model.lifecycle.map((event) => `<tr><td>${escapeHtml(event.stage)}</td><td>${escapeHtml(event.taskId ?? "")}</td><td>${escapeHtml(event.at)}</td><td>${escapeHtml(event.detail ?? "")}</td></tr>`).join("")}</tbody></table></section>${attempts}${model.promotions.length ? `<section><h2>Promotion history</h2><table><thead><tr><th>ID</th><th>Run</th><th>Kind</th><th>Status</th><th>Target</th><th>Conflicts</th></tr></thead><tbody>${model.promotions.map((item) => `<tr><td>${escapeHtml(item.promotionId)}</td><td>${escapeHtml(item.runId)}</td><td>${escapeHtml(item.kind)}</td><td>${escapeHtml(item.status)}</td><td>${escapeHtml(item.targetBranch ?? "")}</td><td>${escapeHtml(item.conflictPaths.join(", "))}</td></tr>`).join("")}</tbody></table></section>` : ""}<section><h2>Failures</h2><pre>${escapeHtml(model.failures.join("\n") || "None")}</pre></section><footer><p>Ariadne uses Git worktrees for repository-state isolation only; it is not an operating-system security sandbox.</p></footer></main></body></html>`;
}
