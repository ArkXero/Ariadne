import crypto from "node:crypto";
import path from "node:path";
import { link, open, unlink } from "node:fs/promises";
import fs from "fs-extra";
import { atomicWriteFile } from "./atomic.js";
import { loadBatchHistory } from "./batch-reader.js";
import { AriadneError } from "./errors.js";
import { createManagementAction, persistManagementAction } from "./management-actions.js";
import { withManagementLock } from "./management-lock.js";
import { canonicalizePath, isPathInside } from "./path-containment.js";
import {
  applyResult,
  discardResult,
  inspectApplyEligibility,
  loadManagedRun,
  loadPromotions,
  previewApplyResult,
  previewDiscardResult,
  type ApplyEligibility,
  type ApplyPreview,
  type DiscardPreview
} from "./promotion.js";
import { loadRunHistory, type RunLoadResult } from "./run-reader.js";
import { repositoryIdentity, resultRefExists } from "./workspace-manager.js";
import type {
  CapturedChange,
  ManagementActionRecord,
  PromotionRecord,
  RunRecord,
  TaskOutcome
} from "../types/index.js";

export const MAX_DIFF_PAGE_BYTES = 64 * 1024;
export const MAX_DIFF_PAGE_LINES = 400;

export type ReviewResultState =
  | "not-applicable" | "unavailable" | "unapplied" | "apply-ineligible" | "applied" | "discarded"
  | "conflicted" | "application-failed" | "missing-artifact" | "corrupt";

export type ReviewResultFilter = "all" | "unapplied" | "conflicted" | "application-failed" | "ineligible" | "discarded" | "applied" | "retained-workspace" | "missing-artifact";

export interface ReviewResult {
  key: string;
  runId: string;
  manifestPath: string;
  taskId: string;
  taskName: string;
  batchId?: string;
  attempt?: number;
  final: boolean;
  executionStatus: string;
  outcome: TaskOutcome | "unknown";
  verificationStatus: "passed" | "failed" | "skipped" | "unavailable";
  policyStatus: "passed" | "failed" | "warning" | "unavailable";
  score: number | null;
  changedFiles: number;
  additions: number;
  deletions: number;
  binaryFiles: number;
  resultState: ReviewResultState;
  workspaceState?: string;
  completedAt: string;
  warning?: string;
}

export interface ResultSummary {
  result: ReviewResult;
  sourceRevision?: string;
  preparedRevision?: string;
  resultRevision?: string;
  isolation?: string;
  workspaceId?: string;
  ineligibleReason?: string;
  omittedSensitive: Array<{ path: string; reason: string; rule?: string; size?: number; sha256?: string }>;
  changes: CapturedChange[];
  promotions: PromotionRecord[];
  failures: string[];
  policyFailures: string[];
}

export interface DiffLine {
  kind: "header" | "hunk" | "added" | "removed" | "context" | "metadata";
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface FileDiffPage {
  runId: string;
  change: CapturedChange;
  status: "ready" | "binary" | "metadata-only" | "missing" | "legacy" | "redacted";
  lines: DiffLine[];
  cursor: string;
  nextCursor?: string;
  previousCursor?: string;
  totalBytes: number;
  truncated: boolean;
  message?: string;
}

export interface AttemptComparison {
  left: ReviewResult;
  right: ReviewResult;
  addedPaths: string[];
  removedPaths: string[];
  sharedPaths: string[];
}

export interface PatchExportPreview {
  runId: string;
  destination: string;
  bytes: number;
  includedFiles: string[];
  excludedSensitiveFiles: string[];
  exists: boolean;
  limitations: string[];
}

export interface ChangeActionOptions {
  signal?: AbortSignal;
  onProgress?: (stage: string) => void;
}

function promotionEvents(promotions: PromotionRecord[], runId: string): PromotionRecord[] {
  return promotions.filter((event) => event.runId === runId || event.includedRunIds.includes(runId))
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.promotionId.localeCompare(right.promotionId));
}

function verification(run: RunRecord): ReviewResult["verificationStatus"] {
  const items = run.results.flatMap((result) => result.verification);
  if (items.length === 0) return "skipped";
  if (items.some((item) => item.status === "failed")) return "failed";
  return items.every((item) => item.status === "skipped") ? "skipped" : "passed";
}

function policy(run: RunRecord): ReviewResult["policyStatus"] {
  const items = run.results.flatMap((result) => result.policies);
  if (items.some((item) => item.outcome === "fail")) return "failed";
  if (items.some((item) => item.outcome === "warning")) return "warning";
  return "passed";
}

async function resultState(root: string, run: RunRecord, events: PromotionRecord[], final: boolean, repositoryId?: string): Promise<ReviewResultState> {
  const relevant = promotionEvents(events, run.runId);
  if (relevant.some((event) => event.kind === "apply" && event.status === "succeeded")) return "applied";
  if (relevant.some((event) => event.kind === "discard" && event.status === "discarded")) return "discarded";
  const latestApply = relevant.filter((event) => event.kind === "apply").at(-1);
  if (latestApply?.status === "conflicted") return "conflicted";
  if (latestApply && ["failed", "interrupted"].includes(latestApply.status)) return "application-failed";
  const artifact = run.changeArtifact;
  if (!artifact) return run.workspace?.strategy === "worktree" ? "unavailable" : "not-applicable";
  if (artifact.manifestArtifact) {
    const manifest = path.resolve(root, artifact.manifestArtifact);
    if (!isPathInside(root, await canonicalizePath(manifest)) || !(await fs.pathExists(manifest))) return "missing-artifact";
  }
  if (artifact.applicable) {
    if (!artifact.resultRevision || !await resultRefExists(root, artifact.resultRevision, run.runId)) return "missing-artifact";
    if (!final || Boolean(run.workspace?.repositoryId && repositoryId && run.workspace.repositoryId !== repositoryId)) return "apply-ineligible";
    return "unapplied";
  }
  return artifact.changes.length > 0 || artifact.omittedSensitive.length > 0 ? "apply-ineligible" : "not-applicable";
}

function finalAttempts(batchItems: Awaited<ReturnType<typeof loadBatchHistory>>["records"]): Set<string> {
  const values = new Set<string>();
  for (const loaded of batchItems) if (loaded.ok) {
    for (const task of loaded.batch.tasks) {
      const final = task.attempts.find((attempt) => attempt.attempt === task.finalAttempt) ?? task.attempts.at(-1);
      if (final) values.add(final.runId);
    }
  }
  return values;
}

async function reviewResult(root: string, loaded: Extract<RunLoadResult, { ok: true }>, promotions: PromotionRecord[], finals: Set<string>, repositoryId?: string): Promise<ReviewResult[]> {
  if (!("runId" in loaded.run)) return [];
  const run = loaded.run;
  const task = run.results[0];
  const artifact = run.changeArtifact;
  const final = !run.workflow || finals.has(run.runId);
  const state = await resultState(root, run, promotions, final, repositoryId);
  return [{
    key: run.runId, runId: run.runId, manifestPath: path.relative(root, loaded.path).split(path.sep).join("/"),
    taskId: task?.task.id ?? run.workflow?.taskId ?? run.runId, taskName: task?.task.name ?? run.workflow?.taskId ?? "Unknown task",
    ...(run.workflow ? { batchId: run.workflow.batchId, attempt: run.workflow.attempt } : {}),
    final, executionStatus: run.status, outcome: run.summary.outcome,
    verificationStatus: verification(run), policyStatus: policy(run), score: task?.score.value ?? null,
    changedFiles: artifact?.changes.length ?? 0,
    additions: artifact?.changes.reduce((sum, change) => sum + (change.additions ?? 0), 0) ?? 0,
    deletions: artifact?.changes.reduce((sum, change) => sum + (change.deletions ?? 0), 0) ?? 0,
    binaryFiles: artifact?.changes.filter((change) => change.binary).length ?? 0,
    resultState: state, workspaceState: run.workspace?.state, completedAt: run.completedAt ?? run.updatedAt
  }];
}

export async function listReviewResults(rootInput: string): Promise<{ results: ReviewResult[]; warnings: string[] }> {
  const root = await fs.realpath(rootInput).catch(() => path.resolve(rootInput));
  const [history, promotionItems, batches] = await Promise.all([loadRunHistory(root), loadPromotions(root), loadBatchHistory(root)]);
  const currentRepositoryId = await repositoryIdentity(root).then((identity) => identity.repositoryId, () => undefined);
  const promotions = promotionItems.flatMap((item) => item.record ? [item.record] : []);
  const finals = finalAttempts(batches.records);
  const values = (await Promise.all(history.records.map(async (loaded): Promise<ReviewResult[]> => {
    if (!loaded.ok) return [{
      key: loaded.path, runId: path.basename(path.dirname(loaded.path)), manifestPath: path.relative(root, loaded.path).split(path.sep).join("/"),
      taskId: "unreadable", taskName: "Unreadable result record", final: true, executionStatus: "unavailable", outcome: "unknown",
      verificationStatus: "unavailable", policyStatus: "unavailable", score: null, changedFiles: 0, additions: 0, deletions: 0,
      binaryFiles: 0, resultState: loaded.code === "unsupported-version" ? "unavailable" : "corrupt", completedAt: "", warning: loaded.error
    }];
    return reviewResult(root, loaded, promotions, finals, currentRepositoryId);
  }))).flat().sort((left, right) => right.completedAt.localeCompare(left.completedAt) || left.runId.localeCompare(right.runId));
  return { results: values, warnings: [...history.warnings, ...promotionItems.flatMap((item) => item.warning ? [item.warning] : []), ...batches.warnings] };
}

export function filterReviewResults(results: ReviewResult[], filter: ReviewResultFilter): ReviewResult[] {
  if (filter === "all") return results.filter((result) => result.resultState !== "not-applicable");
  if (filter === "ineligible") return results.filter((result) => result.resultState === "apply-ineligible");
  if (filter === "retained-workspace") return results.filter((result) => result.workspaceState === "retained");
  if (filter === "missing-artifact") return results.filter((result) => ["missing-artifact", "corrupt", "unavailable"].includes(result.resultState));
  return results.filter((result) => result.resultState === filter);
}

async function loadResult(root: string, idOrPath: string): Promise<{ run: RunRecord; result: ReviewResult }> {
  const run = await loadManagedRun(root, idOrPath);
  const listed = await listReviewResults(root);
  const result = listed.results.find((item) => item.runId === run.runId);
  if (!result) throw new Error(`Review result ${run.runId} is unavailable.`);
  return { run, result };
}

async function assertRunRepository(root: string, run: RunRecord): Promise<void> {
  if (!run.workspace?.repositoryId) return;
  const identity = await repositoryIdentity(root);
  if (identity.repositoryId !== run.workspace.repositoryId) throw new AriadneError({
    category: "promotion_conflict", code: "PROMOTION_REPOSITORY_MISMATCH", stage: "validated",
    message: "Result belongs to a different repository."
  });
}

export async function loadResultSummary(rootInput: string, idOrPath: string): Promise<ResultSummary> {
  const root = await fs.realpath(rootInput).catch(() => path.resolve(rootInput));
  const { run, result } = await loadResult(root, idOrPath);
  const promotions = (await loadPromotions(root)).flatMap((item) => item.record ? [item.record] : []);
  return {
    result, sourceRevision: run.changeArtifact?.sourceRevision, preparedRevision: run.changeArtifact?.preparedRevision,
    resultRevision: run.changeArtifact?.resultRevision, isolation: run.workspace?.strategy, workspaceId: run.workspace?.workspaceId,
    ineligibleReason: run.changeArtifact?.ineligibleReason, omittedSensitive: run.changeArtifact?.omittedSensitive ?? [],
    changes: run.changeArtifact?.changes ?? [], promotions: promotionEvents(promotions, run.runId),
    failures: [...run.failures.map((failure) => `[${failure.code}] ${failure.message}`), ...run.results.flatMap((item) => item.failures.map((failure) => `[${failure.code}] ${failure.message}`))],
    policyFailures: run.results.flatMap((item) => item.policies.filter((value) => value.outcome === "fail").map((value) => `${value.ruleId}: ${value.summary}`))
  };
}

interface DiffCursorState {
  offset: number;
  oldLine?: number;
  newLine?: number;
  trail: Array<{ offset: number; oldLine?: number; newLine?: number }>;
}

function encodeCursor(value: DiffCursorState): string {
  if (value.offset === 0 && value.trail.length === 0) return "start";
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function parseCursor(cursor?: string): DiffCursorState {
  if (!cursor || cursor === "start") return { offset: 0, trail: [] };
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<DiffCursorState>;
    if (!Number.isSafeInteger(value.offset) || value.offset! < 0 || !Array.isArray(value.trail) || value.trail.length > 256) throw new Error("invalid");
    return {
      offset: value.offset!,
      ...(Number.isSafeInteger(value.oldLine) ? { oldLine: value.oldLine } : {}),
      ...(Number.isSafeInteger(value.newLine) ? { newLine: value.newLine } : {}),
      trail: value.trail.filter((item) => Number.isSafeInteger(item?.offset) && item.offset >= 0).slice(-256)
    };
  } catch {
    return { offset: 0, trail: [] };
  }
}

function parseDiffLine(line: string, state: { oldLine?: number; newLine?: number }): DiffLine {
  const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (hunk) {
    state.oldLine = Number(hunk[1]); state.newLine = Number(hunk[2]);
    return { kind: "hunk", text: line };
  }
  if (line.startsWith("+") && !line.startsWith("+++")) {
    const newLine = state.newLine; if (newLine !== undefined) state.newLine = newLine + 1;
    return { kind: "added", text: line, ...(newLine !== undefined ? { newLine } : {}) };
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    const oldLine = state.oldLine; if (oldLine !== undefined) state.oldLine = oldLine + 1;
    return { kind: "removed", text: line, ...(oldLine !== undefined ? { oldLine } : {}) };
  }
  if (line.startsWith(" ")) {
    const oldLine = state.oldLine; const newLine = state.newLine;
    if (oldLine !== undefined) state.oldLine = oldLine + 1;
    if (newLine !== undefined) state.newLine = newLine + 1;
    return { kind: "context", text: line, ...(oldLine !== undefined ? { oldLine } : {}), ...(newLine !== undefined ? { newLine } : {}) };
  }
  return { kind: line.startsWith("diff ") || line.startsWith("---") || line.startsWith("+++") ? "header" : "metadata", text: line };
}

async function readDiffLines(filePath: string, cursor: DiffCursorState): Promise<{ lines: DiffLine[]; hasMore: boolean; totalBytes: number; consumedBytes: number; oldLine?: number; newLine?: number }> {
  const stat = await fs.stat(filePath);
  const handle = await open(filePath, "r");
  const available = Math.max(0, Math.min(MAX_DIFF_PAGE_BYTES, stat.size - cursor.offset));
  const chunk = Buffer.alloc(available);
  const parsed: DiffLine[] = [];
  const state: { oldLine?: number; newLine?: number } = { oldLine: cursor.oldLine, newLine: cursor.newLine };
  let consumedBytes = 0;
  try {
    await handle.read(chunk, 0, available, cursor.offset);
    while (consumedBytes < chunk.length && parsed.length < MAX_DIFF_PAGE_LINES) {
      const newline = chunk.indexOf(0x0a, consumedBytes);
      const end = newline === -1 ? chunk.length : newline;
      const line = chunk.subarray(consumedBytes, end).toString("utf8").replace(/\r$/, "");
      parsed.push(parseDiffLine(line, state));
      consumedBytes = newline === -1 ? chunk.length : newline + 1;
    }
  } finally {
    await handle.close();
  }
  return { lines: parsed, hasMore: cursor.offset + consumedBytes < stat.size, totalBytes: stat.size, consumedBytes, ...state };
}

export async function loadFileDiff(rootInput: string, idOrPath: string, changeIdOrPath: string, cursor?: string): Promise<FileDiffPage> {
  const root = await fs.realpath(rootInput).catch(() => path.resolve(rootInput));
  const run = await loadManagedRun(root, idOrPath);
  await assertRunRepository(root, run);
  const artifact = run.changeArtifact;
  if (!artifact) throw new Error("Change artifact is unavailable.");
  const change = artifact.changes.find((item) => item.changeId === changeIdOrPath || item.path === changeIdOrPath);
  if (!change) throw new Error("Changed file is not present in the durable manifest.");
  if (artifact.omittedSensitive.some((item) => item.path === change.path || item.path === change.originalPath)) {
    return { runId: run.runId, change, status: "redacted", lines: [], cursor: "0", totalBytes: 0, truncated: false, message: "Sensitive file content is redacted." };
  }
  const cursorState = parseCursor(cursor);
  const canonicalCursor = encodeCursor(cursorState);
  if (change.binary || change.diff?.status === "binary") return { runId: run.runId, change, status: "binary", lines: [], cursor: canonicalCursor, totalBytes: change.diff?.bytes ?? 0, truncated: false, message: change.diff?.reason ?? "Binary content is metadata-only." };
  if (change.diff && ["metadata-only", "unavailable"].includes(change.diff.status)) return { runId: run.runId, change, status: "metadata-only", lines: [], cursor: canonicalCursor, totalBytes: change.diff.bytes, truncated: true, message: change.diff.reason };
  const relativeArtifact = artifact.schemaVersion === 1 ? artifact.previewArtifact : change.diff?.artifact;
  if (!relativeArtifact) return { runId: run.runId, change, status: "missing", lines: [], cursor: canonicalCursor, totalBytes: 0, truncated: false, message: change.diff?.reason ?? "No text diff artifact is available." };
  const candidate = path.resolve(root, relativeArtifact);
  if (!isPathInside(root, await canonicalizePath(candidate))) throw new Error("Diff artifact path leaves the project root.");
  if (!(await fs.pathExists(candidate))) return { runId: run.runId, change, status: "missing", lines: [], cursor: canonicalCursor, totalBytes: 0, truncated: false, message: "Diff artifact is missing." };
  const page = await readDiffLines(candidate, cursorState);
  const nextState: DiffCursorState = {
    offset: cursorState.offset + page.consumedBytes,
    ...(page.oldLine !== undefined ? { oldLine: page.oldLine } : {}),
    ...(page.newLine !== undefined ? { newLine: page.newLine } : {}),
    trail: [...cursorState.trail, { offset: cursorState.offset, ...(cursorState.oldLine !== undefined ? { oldLine: cursorState.oldLine } : {}), ...(cursorState.newLine !== undefined ? { newLine: cursorState.newLine } : {}) }].slice(-256)
  };
  const previous = cursorState.trail.at(-1);
  const previousState: DiffCursorState | undefined = previous ? { ...previous, trail: cursorState.trail.slice(0, -1) } : undefined;
  return {
    runId: run.runId, change, status: artifact.schemaVersion === 1 ? "legacy" : change.binary ? "binary" : "ready",
    lines: page.lines, cursor: canonicalCursor, ...(page.hasMore && page.consumedBytes > 0 ? { nextCursor: encodeCursor(nextState) } : {}),
    ...(previousState ? { previousCursor: encodeCursor(previousState) } : {}),
    totalBytes: page.totalBytes, truncated: page.hasMore || cursorState.offset > 0,
    ...(artifact.schemaVersion === 1 ? { message: "Legacy v1 artifact: showing its bounded whole-result preview." } : {})
  };
}

export async function compareAttemptResults(rootInput: string, leftId: string, rightId: string): Promise<AttemptComparison> {
  const root = await fs.realpath(rootInput).catch(() => path.resolve(rootInput));
  const [leftSummary, rightSummary] = await Promise.all([loadResultSummary(root, leftId), loadResultSummary(root, rightId)]);
  const leftPaths = new Set(leftSummary.changes.map((change) => change.path));
  const rightPaths = new Set(rightSummary.changes.map((change) => change.path));
  return {
    left: leftSummary.result, right: rightSummary.result,
    addedPaths: [...rightPaths].filter((value) => !leftPaths.has(value)).sort(),
    removedPaths: [...leftPaths].filter((value) => !rightPaths.has(value)).sort(),
    sharedPaths: [...leftPaths].filter((value) => rightPaths.has(value)).sort()
  };
}

export { applyResult, discardResult, inspectApplyEligibility, previewApplyResult, previewDiscardResult };
export type { ApplyEligibility, ApplyPreview, DiscardPreview };

export async function loadBoundedResultPreview(rootInput: string, idOrPath: string): Promise<{ runId: string; preview: string }> {
  const root = await fs.realpath(rootInput).catch(() => path.resolve(rootInput));
  const run = await loadManagedRun(root, idOrPath);
  const relative = run.changeArtifact?.previewArtifact;
  if (!relative) throw new AriadneError({ category: "promotion_conflict", code: "CHANGE_DIFF_MISSING", stage: "loading", message: `Run ${run.runId} has no safe diff preview.` });
  const candidate = path.resolve(root, relative);
  if (!isPathInside(root, await canonicalizePath(candidate))) throw new AriadneError({ category: "persistence", code: "CHANGE_PREVIEW_UNSAFE", stage: "loading", message: "The bounded preview path leaves the project root." });
  const preview = await fs.readFile(candidate, "utf8").catch(() => { throw new AriadneError({ category: "persistence", code: "CHANGE_PREVIEW_MISSING", stage: "loading", message: "The bounded change preview artifact is missing." }); });
  return { runId: run.runId, preview };
}

export async function applyReviewedResult(root: string, idOrPath: string, fingerprint: string, options: ChangeActionOptions = {}): Promise<PromotionRecord> {
  if (options.signal?.aborted) throw new Error("Apply interrupted before validation.");
  options.onProgress?.("validating");
  const eligibility = await inspectApplyEligibility(root, idOrPath);
  if (!eligibility.eligible || eligibility.fingerprint !== fingerprint) throw new AriadneError({ category: "promotion_conflict", code: "PROMOTION_PREVIEW_STALE", stage: "validated", message: "Apply preview is stale or no longer eligible.", correction: "Refresh the preview and try again." });
  options.onProgress?.("applying");
  const record = await applyResult(root, idOrPath, fingerprint);
  options.onProgress?.("recorded");
  return record;
}

export async function discardReviewedResult(root: string, idOrPath: string, options: ChangeActionOptions = {}): Promise<PromotionRecord> {
  if (options.signal?.aborted) throw new Error("Discard interrupted before validation.");
  options.onProgress?.("validating");
  const record = await discardResult(root, idOrPath);
  options.onProgress?.("recorded");
  return record;
}

function slug(value: string): string {
  return value.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "result";
}

async function defaultExportPath(root: string, taskId: string, runId: string): Promise<string> {
  const base = `${slug(taskId)}-${slug(runId).slice(-12)}`;
  for (let index = 1; index < 10_000; index += 1) {
    const name = index === 1 ? `${base}.patch` : `${base}-${index}.patch`;
    const value = path.join(".ariadne", "exports", name).split(path.sep).join("/");
    if (!(await fs.pathExists(path.join(root, value)))) return value;
  }
  throw new Error("Could not allocate a unique patch export path.");
}

export async function previewPatchExport(rootInput: string, idOrPath: string, destination?: string): Promise<PatchExportPreview> {
  const root = await fs.realpath(rootInput).catch(() => path.resolve(rootInput));
  const { run, result } = await loadResult(root, idOrPath);
  await assertRunRepository(root, run);
  const patchArtifact = run.changeArtifact?.patchArtifact;
  if (!patchArtifact) throw new Error("Complete safe patch artifact is unavailable.");
  const source = path.resolve(root, patchArtifact);
  if (!isPathInside(root, await canonicalizePath(source)) || !(await fs.pathExists(source))) throw new Error("Complete safe patch artifact is missing or unsafe.");
  const targetRelative = destination ?? await defaultExportPath(root, result.taskId, run.runId);
  const target = path.resolve(root, targetRelative);
  if (!isPathInside(root, await canonicalizePath(target))) throw new Error("Patch export path must stay inside the project root.");
  return {
    runId: run.runId, destination: path.relative(root, target).split(path.sep).join("/"), bytes: (await fs.stat(source)).size,
    includedFiles: run.changeArtifact?.changes.map((change) => change.path) ?? [],
    excludedSensitiveFiles: run.changeArtifact?.omittedSensitive.map((item) => item.path) ?? [], exists: await fs.pathExists(target),
    limitations: ["Git-native result refs remain canonical.", "Platform-specific symlink and executable-mode behavior depends on the target Git environment."]
  };
}

export async function exportPatch(rootInput: string, idOrPath: string, destination: string, force = false, options: ChangeActionOptions = {}): Promise<{ path: string; action: ManagementActionRecord }> {
  const root = await fs.realpath(rootInput).catch(() => path.resolve(rootInput));
  return withManagementLock(root, `export ${idOrPath}`, async () => {
    const preview = await previewPatchExport(root, idOrPath, destination);
    const run = await loadManagedRun(root, idOrPath);
    const identity = await repositoryIdentity(root);
    const target = path.resolve(root, preview.destination);
    if (preview.exists && !force) throw new AriadneError({ category: "configuration", code: "PATCH_EXPORT_EXISTS", stage: "validated", message: `Patch export already exists: ${preview.destination}`, correction: "Choose another path or pass --force." });
    const action = createManagementAction({ kind: "patch-export", repositoryId: identity.repositoryId, runId: run.runId, destination: preview.destination });
    if (options.signal?.aborted) {
      action.status = "interrupted";
      action.error = "Patch export interrupted before writing.";
      action.outcomes.push({ resourceId: run.runId, status: "failed", detail: action.error });
      await persistManagementAction(root, action);
      throw new Error(action.error);
    }
    const contents = await fs.readFile(path.resolve(root, run.changeArtifact!.patchArtifact!));
    options.onProgress?.("writing");
    try {
      if (force) await atomicWriteFile(target, contents);
      else {
        await fs.ensureDir(path.dirname(target));
        const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
        await atomicWriteFile(temporary, contents);
        try { await link(temporary, target); } finally { await unlink(temporary).catch(() => undefined); }
      }
      action.status = "succeeded"; action.bytes = contents.length;
      action.outcomes.push({ resourceId: run.runId, status: "succeeded", detail: `Exported ${preview.destination}.` });
    } catch (error) {
      action.status = options.signal?.aborted ? "interrupted" : "failed";
      action.error = error instanceof Error ? error.message : String(error);
      action.outcomes.push({ resourceId: run.runId, status: "failed", detail: action.error });
      await persistManagementAction(root, action);
      throw error;
    }
    await persistManagementAction(root, action);
    return { path: preview.destination, action };
  });
}
