import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import fs from "fs-extra";
import { atomicWriteJson } from "./atomic.js";
import { loadBatchFile, resolveBatchFile } from "./batch-reader.js";
import { captureRepositorySnapshot } from "./git.js";
import { loadRunFile, loadRunHistory, resolveRunFile } from "./run-reader.js";
import { AriadneError } from "./errors.js";
import { withManagementLock } from "./management-lock.js";
import { DEFAULT_IO_CONCURRENCY, mapWithConcurrency } from "./bounded-map.js";
import { loadWorkspace, removeWorkspace, repositoryIdentity, resultRefExists } from "./workspace-manager.js";
import { PromotionRecordSchema } from "../schema/promotion-record.js";
import {
  CURRENT_PROMOTION_SCHEMA_VERSION,
  type BatchRecord,
  type PromotionConflict,
  type PromotionRecord,
  type RunRecord
} from "../types/index.js";

const GIT_TIMEOUT_MS = 30_000;
const MANAGED_COMMIT_CONFIG = [
  "-c", "user.name=Ariadne",
  "-c", "user.email=ariadne@local.invalid",
  "-c", "commit.gpgSign=false"
];

export interface ApplyEligibilityCheck {
  id: string;
  label: string;
  status: "pass" | "warning" | "fail";
  detail: string;
}

export interface ApplyEligibility {
  runId: string;
  eligible: boolean;
  checks: ApplyEligibilityCheck[];
  targetRepository: string;
  targetBranch?: string;
  targetRevision?: string;
  closureRunIds: string[];
  fingerprint?: string;
}

export interface ApplyPreview extends ApplyEligibility {
  preflight: "clean" | "conflict" | "unavailable";
  conflicts: PromotionConflict[];
  strategy: "preflight-squash-cherry-pick";
  changedFiles: number;
  additions: number;
  deletions: number;
  highRiskReasons: string[];
}

export interface DiscardPreview {
  runId: string;
  eligible: boolean;
  alreadyDiscarded: boolean;
  resultRef?: string;
  workspaceId?: string;
  workspaceState?: string;
  removesWorkspace: boolean;
  preserves: string[];
  blockers: string[];
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execa("git", args, { cwd, reject: false, timeout: GIT_TIMEOUT_MS, stripFinalNewline: false });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 0 };
  } catch (error) {
    return { stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 127 };
  }
}

function promotionId(now = new Date()): string {
  return `${now.toISOString().replace(/[-:.]/g, "")}-${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

function promotionsRoot(root: string): string { return path.join(root, ".ariadne", "promotions"); }

async function persist(root: string, record: PromotionRecord): Promise<void> {
  record.updatedAt = new Date().toISOString();
  const parsed = PromotionRecordSchema.safeParse(record);
  if (!parsed.success) throw new AriadneError({ category: "persistence", code: "PROMOTION_RECORD_INVALID", stage: "persisting", message: `Refusing to persist invalid promotion metadata: ${parsed.error.message}` });
  await atomicWriteJson(path.join(promotionsRoot(root), `${record.promotionId}.json`), parsed.data);
}

function initial(kind: PromotionRecord["kind"], run: RunRecord, repositoryId: string): PromotionRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: CURRENT_PROMOTION_SCHEMA_VERSION, promotionId: promotionId(), kind, status: "validating", runId: run.runId,
    includedRunIds: [run.runId], repositoryId, conflictPaths: [], startedAt: now, updatedAt: now,
    owner: { pid: process.pid, hostname: os.hostname(), startedAt: now }, lifecycle: [{ status: "validating", at: now }]
  };
}

async function transition(root: string, record: PromotionRecord, status: PromotionRecord["status"], detail?: string): Promise<void> {
  record.status = status;
  record.lifecycle.push({ status, at: new Date().toISOString(), ...(detail ? { detail } : {}) });
  if (["succeeded", "conflicted", "discarded", "interrupted", "failed"].includes(status)) record.completedAt = new Date().toISOString();
  await persist(root, record);
}

export async function loadPromotions(root: string): Promise<Array<{ path: string; record?: PromotionRecord; warning?: string }>> {
  const directory = promotionsRoot(root);
  const files = (await fs.readdir(directory).catch(() => [] as string[])).filter((name) => name.endsWith(".json")).sort();
  return mapWithConcurrency(files, DEFAULT_IO_CONCURRENCY, async (name) => {
    const filePath = path.join(directory, name);
    const parsed = PromotionRecordSchema.safeParse(await fs.readJson(filePath).catch(() => undefined));
    if (!parsed.success) return { path: filePath, warning: `Promotion record is corrupt: ${filePath}` };
    const value = parsed.data;
    if (value.schemaVersion === CURRENT_PROMOTION_SCHEMA_VERSION) return { path: filePath, record: value };
    const failed = ["conflicted", "failed", "interrupted"].includes(value.status);
    const legacyMessage = value.error ?? value.lifecycle.at(-1)?.detail ?? `Legacy promotion ended with status ${value.status}.`;
    const record: PromotionRecord = {
      ...value,
      schemaVersion: CURRENT_PROMOTION_SCHEMA_VERSION,
      ...(value.conflictPaths.length > 0 ? { conflicts: value.conflictPaths.map((conflictPath) => ({ path: conflictPath, category: "unknown" as const })) } : {}),
      ...(failed ? {
        failure: {
          category: value.status === "conflicted" ? "conflict" as const : value.status === "interrupted" ? "interrupted" as const : "unknown" as const,
          code: "LEGACY_PROMOTION_FAILURE",
          message: legacyMessage,
          targetModified: false,
          rollbackAttempted: false,
          manualRecoveryRequired: false,
          recoveryCommands: []
        }
      } : {}),
      ...(value.kind === "discard" && value.status === "discarded" ? { discard: { resultRefRemoved: true, historyPreserved: true as const } } : {})
    };
    return { path: filePath, record };
  });
}

async function currentPromotionState(root: string, runId: string): Promise<{ applied?: PromotionRecord; discarded?: PromotionRecord }> {
  const records = (await loadPromotions(root)).flatMap((item) => item.record ? [item.record] : []);
  return {
    applied: records.find((item) => item.kind === "apply" && item.status === "succeeded" && item.includedRunIds.includes(runId)),
    discarded: records.find((item) => item.kind === "discard" && item.status === "discarded" && item.runId === runId)
  };
}

async function recoverOwnedCherryPick(root: string): Promise<void> {
  const gitPath = await git(root, ["rev-parse", "--path-format=absolute", "--git-path", "CHERRY_PICK_HEAD"]);
  if (gitPath.exitCode !== 0 || !(await fs.pathExists(gitPath.stdout.trim()))) return;
  const cherryRevision = (await fs.readFile(gitPath.stdout.trim(), "utf8")).trim();
  const head = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  const candidates = (await loadPromotions(root)).flatMap((item) => item.record?.status === "applying" ? [item.record] : []);
  const owned = candidates.find((item) => item.promotionCommit === cherryRevision && item.preApplyRevision === head);
  if (!owned) {
    throw new AriadneError({
      category: "promotion_conflict", code: "UNOWNED_CHERRY_PICK_IN_PROGRESS", stage: "validated",
      message: "A cherry-pick is already in progress and Ariadne cannot prove ownership.",
      correction: "Resolve or abort the existing Git operation manually, then retry. Ariadne did not modify it."
    });
  }
  const aborted = await git(root, ["cherry-pick", "--abort"]);
  if (aborted.exitCode !== 0) throw new AriadneError({ category: "promotion_conflict", code: "OWNED_CHERRY_PICK_RECOVERY_FAILED", stage: "validated", message: "Ariadne identified its incomplete cherry-pick but could not abort it safely.", correction: `Run git cherry-pick --abort after confirming promotion ${owned.promotionId}.` });
  owned.error = "Recovered an Ariadne-owned incomplete cherry-pick before a later apply attempt.";
  await transition(root, owned, "failed", owned.error);
}

export async function loadManagedRun(root: string, idOrPath: string): Promise<RunRecord> {
  const loaded = await loadRunFile(await resolveRunFile(root, idOrPath));
  if (!loaded.ok || loaded.legacy || !("runId" in loaded.run)) {
    throw new AriadneError({ category: loaded.ok ? "promotion_conflict" : "persistence", code: "RUN_NOT_MANAGEABLE", stage: "loading", message: loaded.ok ? "Legacy runs do not contain managed result artifacts." : loaded.error });
  }
  return loaded.run;
}

async function promotionClosure(root: string, run: RunRecord): Promise<RunRecord[]> {
  if (!run.workflow) return [run];
  const batchLoaded = await loadBatchFile(await resolveBatchFile(root, run.workflow.batchId), root);
  if (!batchLoaded.ok) return [run];
  const batch: BatchRecord = batchLoaded.batch;
  const plan = batch.plan;
  if (!plan) return [run];
  const targetTask = batch.tasks.find((task) => task.id.toLowerCase() === run.workflow!.taskId.toLowerCase());
  if (!targetTask) return [run];
  const needed = new Set<string>();
  const visit = (id: string): void => {
    if (needed.has(id)) return;
    const task = batch.tasks.find((item) => item.id === id);
    if (!task) return;
    for (const dependency of task.dependencies) visit(dependency);
    needed.add(id);
  };
  visit(targetTask.id);
  const result: RunRecord[] = [];
  for (const id of plan.order.filter((taskId) => needed.has(taskId))) {
    const task = batch.tasks.find((item) => item.id === id);
    const attempt = task?.finalAttempt === undefined ? undefined : task.attempts.find((item) => item.attempt === task.finalAttempt);
    if (!attempt) continue;
    const loaded = await loadRunFile(path.resolve(root, attempt.manifest));
    if (loaded.ok && !loaded.legacy && "runId" in loaded.run) result.push(loaded.run);
  }
  return result.length > 0 ? result : [run];
}

function requireApplicable(run: RunRecord): void {
  if (!run.changeArtifact?.applicable || !run.changeArtifact.resultRevision || !run.workspace?.repositoryId) {
    throw new AriadneError({
      category: "promotion_conflict", code: "RESULT_NOT_APPLICABLE", stage: "validated",
      message: `Run ${run.runId} does not contain an applicable isolated result.`,
      correction: run.changeArtifact?.ineligibleReason ?? "Run a successful task with --isolation worktree and non-empty safe changes."
    });
  }
}

function promotionFingerprint(value: {
  runId: string;
  repositoryId: string;
  branch: string;
  targetRevision: string;
  closure: RunRecord[];
}): string {
  return crypto.createHash("sha256").update(JSON.stringify({
    runId: value.runId,
    repositoryId: value.repositoryId,
    branch: value.branch,
    targetRevision: value.targetRevision,
    closure: value.closure.map((run) => ({ runId: run.runId, revision: run.changeArtifact?.resultRevision }))
  })).digest("hex");
}

function conflictsFor(run: RunRecord, paths: string[]): PromotionConflict[] {
  const changes = new Map(run.changeArtifact?.changes.map((change) => [change.path, change]) ?? []);
  return paths.map((filePath) => {
    const change = changes.get(filePath);
    return {
      path: filePath,
      category: change?.binary ? "binary" : change?.changeType === "renamed" ? "rename" : "content"
    };
  });
}

async function eligibilityData(rootInput: string, idOrPath: string): Promise<{
  root: string;
  run: RunRecord;
  identity: Awaited<ReturnType<typeof repositoryIdentity>>;
  branch?: string;
  closure: RunRecord[];
  checks: ApplyEligibilityCheck[];
}> {
  const root = await fs.realpath(rootInput).catch(() => path.resolve(rootInput));
  const checks: ApplyEligibilityCheck[] = [];
  const run = await loadManagedRun(root, idOrPath);
  const artifact = run.changeArtifact;
  if (run.workflow) {
    const batch = await loadBatchFile(await resolveBatchFile(root, run.workflow.batchId), root);
    const task = batch.ok ? batch.batch.tasks.find((item) => item.id.toLowerCase() === run.workflow!.taskId.toLowerCase()) : undefined;
    const final = task?.attempts.find((attempt) => attempt.attempt === task.finalAttempt) ?? task?.attempts.at(-1);
    const promotable = final?.runId === run.runId;
    checks.push({
      id: "final-attempt",
      label: "Final workflow attempt",
      status: promotable ? "pass" : "fail",
      detail: promotable ? "This is the workflow task's final attempt." : "Earlier retries are reviewable and exportable but cannot be applied."
    });
  } else {
    checks.push({ id: "standalone", label: "Standalone result", status: "pass", detail: "Standalone runs are promotion candidates." });
  }
  if (artifact?.manifestArtifact && await fs.pathExists(path.resolve(root, artifact.manifestArtifact))) checks.push({ id: "artifact", label: "Result artifact available", status: "pass", detail: artifact.manifestArtifact });
  else checks.push({ id: "artifact", label: "Result artifact available", status: "fail", detail: "The durable change manifest is missing." });
  if (artifact?.applicable && artifact.resultRevision && run.workspace?.repositoryId) checks.push({ id: "applicable", label: "Result marked applicable", status: "pass", detail: artifact.resultRevision });
  else checks.push({ id: "applicable", label: "Result marked applicable", status: "fail", detail: artifact?.ineligibleReason ?? "No applicable isolated result exists." });

  const identity = await repositoryIdentity(root);
  const repositoryMatches = identity.repositoryId === run.workspace?.repositoryId;
  checks.push({ id: "repository", label: "Repository identity matches", status: repositoryMatches ? "pass" : "fail", detail: repositoryMatches ? identity.repositoryId : "Result belongs to a different repository." });
  const state = await currentPromotionState(root, run.runId);
  checks.push({ id: "state", label: "Result has not been applied or discarded", status: state.applied || state.discarded ? "fail" : "pass", detail: state.applied ? `Already applied by ${state.applied.promotionId}.` : state.discarded ? `Discarded by ${state.discarded.promotionId}.` : "Unapplied." });

  const repository = await captureRepositorySnapshot(root, [".ariadne"]);
  const dirtyPaths = repository.entries.filter((entry) => entry.changeType !== "ignored").map((entry) => entry.path);
  checks.push({ id: "clean", label: "Target working tree clean", status: repository.available && !repository.dirty ? "pass" : "fail", detail: repository.available ? dirtyPaths.join(", ") || "Clean." : repository.unavailableReason ?? "Git state unavailable." });
  const branchResult = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : undefined;
  checks.push({ id: "branch", label: "Target is on a named branch", status: branch ? "pass" : "fail", detail: branch ?? "Detached HEAD." });

  const planned = await promotionClosure(root, run);
  const closure: RunRecord[] = [];
  for (const child of planned) {
    const childState = await currentPromotionState(root, child.runId);
    if (childState.discarded) {
      checks.push({ id: `dependency:${child.runId}`, label: `Dependency ${child.runId}`, status: "fail", detail: "Required result was discarded." });
      continue;
    }
    if (childState.applied) {
      const contained = Boolean(branch && childState.applied.targetBranch === branch && childState.applied.postApplyRevision)
        && (await git(root, ["merge-base", "--is-ancestor", childState.applied.postApplyRevision!, "HEAD"])).exitCode === 0;
      checks.push({ id: `dependency:${child.runId}`, label: `Dependency ${child.runId}`, status: contained ? "pass" : "fail", detail: contained ? "Already present on this target." : "Applied elsewhere but not present on this branch." });
      continue;
    }
    closure.push(child);
    const revision = child.changeArtifact?.resultRevision;
    const exists = Boolean(revision) && await resultRefExists(root, revision!, child.runId);
    checks.push({ id: `result:${child.runId}`, label: `Managed result ${child.runId}`, status: child.changeArtifact?.applicable && exists ? "pass" : "fail", detail: exists ? revision! : "Result ref is missing, mismatched, or ineligible." });
  }
  if (identity.sourceRevision !== artifact?.sourceRevision) checks.push({ id: "advanced", label: "Target branch advancement", status: "warning", detail: `Target advanced from ${artifact?.sourceRevision ?? "unknown"} to ${identity.sourceRevision}; preflight is required.` });
  return { root, run, identity, branch, closure, checks };
}

export async function inspectApplyEligibility(rootInput: string, idOrPath: string): Promise<ApplyEligibility> {
  const data = await eligibilityData(rootInput, idOrPath);
  const eligible = data.checks.every((check) => check.status !== "fail");
  return {
    runId: data.run.runId, eligible, checks: data.checks, targetRepository: data.root,
    ...(data.branch ? { targetBranch: data.branch } : {}), targetRevision: data.identity.sourceRevision,
    closureRunIds: data.closure.map((run) => run.runId),
    ...(eligible && data.branch ? { fingerprint: promotionFingerprint({ runId: data.run.runId, repositoryId: data.identity.repositoryId, branch: data.branch, targetRevision: data.identity.sourceRevision, closure: data.closure }) } : {})
  };
}

export async function previewApplyResult(rootInput: string, idOrPath: string): Promise<ApplyPreview> {
  const data = await eligibilityData(rootInput, idOrPath);
  const eligible = data.checks.every((check) => check.status !== "fail");
  const changes = data.closure.flatMap((run) => run.changeArtifact?.changes ?? []);
  const previousConflict = (await loadPromotions(data.root)).some((item) => item.record?.kind === "apply" && item.record.status === "conflicted" && item.record.includedRunIds.includes(data.run.runId));
  const highRiskReasons = [
    ...(changes.some((change) => change.binary) ? ["Includes binary changes."] : []),
    ...(changes.some((change) => change.kind === "symlink" || change.changeType === "symlink-changed") ? ["Includes symlink changes."] : []),
    ...(changes.some((change) => change.changeType === "mode-changed") ? ["Includes file-mode changes."] : []),
    ...(data.checks.some((check) => check.id === "advanced") ? ["Target branch advanced after the result source revision."] : []),
    ...(changes.length > 100 || changes.reduce((sum, change) => sum + (change.additions ?? 0) + (change.deletions ?? 0), 0) > 10_000 ? ["Result is unusually large."] : []),
    ...(previousConflict ? ["A previous apply attempt conflicted."] : [])
  ];
  let preflight: ApplyPreview["preflight"] = eligible ? "clean" : "unavailable";
  let conflicts: PromotionConflict[] = [];
  if (eligible) {
    const previewRoot = path.join(data.root, ".ariadne", "worktrees", `promotion-preview-${crypto.randomUUID()}`);
    const checkout = path.join(previewRoot, "checkout");
    try {
      await fs.ensureDir(previewRoot);
      const added = await git(data.root, ["worktree", "add", "--detach", checkout, data.identity.sourceRevision]);
      if (added.exitCode !== 0) preflight = "unavailable";
      else {
        for (const child of data.closure) {
          const picked = await git(checkout, [...MANAGED_COMMIT_CONFIG, "cherry-pick", child.changeArtifact!.resultRevision!]);
          if (picked.exitCode !== 0) {
            const paths = (await git(checkout, ["diff", "--name-only", "--diff-filter=U"])).stdout.split(/\r?\n/).filter(Boolean).sort();
            conflicts = conflictsFor(child, paths);
            await git(checkout, ["cherry-pick", "--abort"]);
            preflight = "conflict";
            break;
          }
        }
      }
    } finally {
      await git(data.root, ["worktree", "remove", "--force", checkout]);
      await fs.remove(previewRoot).catch(() => undefined);
    }
  }
  return {
    runId: data.run.runId, eligible, checks: data.checks, targetRepository: data.root,
    ...(data.branch ? { targetBranch: data.branch } : {}), targetRevision: data.identity.sourceRevision,
    closureRunIds: data.closure.map((run) => run.runId),
    ...(eligible && data.branch ? { fingerprint: promotionFingerprint({ runId: data.run.runId, repositoryId: data.identity.repositoryId, branch: data.branch, targetRevision: data.identity.sourceRevision, closure: data.closure }) } : {}),
    preflight, conflicts, strategy: "preflight-squash-cherry-pick", changedFiles: changes.length,
    additions: changes.reduce((sum, change) => sum + (change.additions ?? 0), 0),
    deletions: changes.reduce((sum, change) => sum + (change.deletions ?? 0), 0), highRiskReasons
  };
}

export async function previewDiscardResult(rootInput: string, idOrPath: string): Promise<DiscardPreview> {
  const root = await fs.realpath(rootInput).catch(() => path.resolve(rootInput));
  const run = await loadManagedRun(root, idOrPath);
  const state = await currentPromotionState(root, run.runId);
  const blockers: string[] = [];
  if (state.applied) blockers.push("Applied results cannot be discarded.");
  if (!run.changeArtifact?.resultRef) blockers.push("No managed result ref exists.");
  if (run.workspace?.repositoryId !== (await repositoryIdentity(root)).repositoryId) blockers.push("Result belongs to a different repository.");
  return {
    runId: run.runId, eligible: blockers.length === 0, alreadyDiscarded: Boolean(state.discarded), resultRef: run.changeArtifact?.resultRef,
    workspaceId: run.workspace?.workspaceId, workspaceState: run.workspace?.state,
    removesWorkspace: run.workspace?.state === "retained",
    preserves: ["run and batch manifests", "stdout and stderr artifacts", "reports", "safe patch artifacts", "promotion history"], blockers
  };
}

async function applyResultUnlocked(rootInput: string, idOrPath: string, expectedFingerprint?: string): Promise<PromotionRecord> {
  const root = await fs.realpath(rootInput).catch(() => path.resolve(rootInput));
  await recoverOwnedCherryPick(root);
  const run = await loadManagedRun(root, idOrPath);
  requireApplicable(run);
  const identity = await repositoryIdentity(root);
  if (identity.repositoryId !== run.workspace!.repositoryId) throw new AriadneError({ category: "promotion_conflict", code: "PROMOTION_REPOSITORY_MISMATCH", stage: "validated", message: "Result belongs to a different repository." });
  const state = await currentPromotionState(root, run.runId);
  if (state.applied) throw new AriadneError({ category: "promotion_conflict", code: "RESULT_ALREADY_APPLIED", stage: "validated", message: `Run ${run.runId} was already applied by ${state.applied.promotionId}.` });
  if (state.discarded) throw new AriadneError({ category: "promotion_conflict", code: "RESULT_DISCARDED", stage: "validated", message: `Run ${run.runId} was discarded and cannot be applied.` });
  const repository = await captureRepositorySnapshot(root, [".ariadne"]);
  const dirtyPaths = repository.entries.filter((entry) => entry.changeType !== "ignored").map((entry) => entry.path);
  if (!repository.available || repository.dirty) throw new AriadneError({
    category: "promotion_conflict", code: "PROMOTION_TARGET_DIRTY", stage: "validated",
    message: "Apply requires a clean primary checkout; Ariadne will not stash user changes.",
    fieldPath: "repository", offendingValue: dirtyPaths,
    expected: "A clean named-branch checkout containing no tracked, staged, unstaged, or untracked changes.",
    correction: "Commit or clean the listed paths before applying; Ariadne will not stash or discard them.",
    details: { paths: dirtyPaths, ...(repository.available ? {} : { unavailableReason: repository.unavailableReason }) }
  });
  const branch = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch.exitCode !== 0) throw new AriadneError({ category: "promotion_conflict", code: "PROMOTION_NAMED_BRANCH_REQUIRED", stage: "validated", message: "Apply requires the primary checkout to be on a named branch." });
  const plannedClosure = await promotionClosure(root, run);
  const closure: RunRecord[] = [];
  for (const child of plannedClosure) {
    const childState = await currentPromotionState(root, child.runId);
    if (childState.discarded) throw new AriadneError({ category: "promotion_conflict", code: "DEPENDENCY_RESULT_DISCARDED", stage: "validated", message: `Required result ${child.runId} was discarded and cannot be promoted as part of this closure.` });
    if (childState.applied) {
      const contained = childState.applied.targetBranch === branch.stdout.trim() && Boolean(childState.applied.postApplyRevision)
        && (await git(root, ["merge-base", "--is-ancestor", childState.applied.postApplyRevision!, "HEAD"])).exitCode === 0;
      if (!contained) throw new AriadneError({ category: "promotion_conflict", code: "DEPENDENCY_PROMOTION_NOT_ON_TARGET", stage: "validated", message: `Required result ${child.runId} was promoted elsewhere but is not present on the current target branch.` });
    } else closure.push(child);
  }
  for (const child of closure) if (child.changeArtifact?.resultRevision) {
    requireApplicable(child);
    if (!await resultRefExists(root, child.changeArtifact.resultRevision, child.runId)) {
      throw new AriadneError({ category: "promotion_conflict", code: "RESULT_REF_MISSING", stage: "validated", message: `Managed result ref for run ${child.runId} is missing or does not match its recorded revision.`, correction: "Rerun the task; historical manifests are not rewritten." });
    }
  }
  const fingerprint = promotionFingerprint({
    runId: run.runId, repositoryId: identity.repositoryId, branch: branch.stdout.trim(),
    targetRevision: identity.sourceRevision, closure
  });
  if (expectedFingerprint && expectedFingerprint !== fingerprint) {
    throw new AriadneError({
      category: "promotion_conflict", code: "PROMOTION_PREVIEW_STALE", stage: "validated",
      message: "The apply preview is stale because the target or result closure changed.",
      correction: "Refresh eligibility and preview the result again before applying."
    });
  }
  const record = initial("apply", run, identity.repositoryId);
  record.includedRunIds = closure.map((item) => item.runId);
  record.targetBranch = branch.stdout.trim();
  record.preApplyRevision = identity.sourceRevision;
  record.strategy = "preflight-squash-cherry-pick";
  await persist(root, record);
  const preflightRoot = path.join(root, ".ariadne", "worktrees", `promotion-${record.promotionId}`);
  const checkout = path.join(preflightRoot, "checkout");
  record.cleanup = { preflightPath: path.relative(root, checkout).split(path.sep).join("/") };
  try {
    await fs.ensureDir(preflightRoot);
    const added = await git(root, ["worktree", "add", "--detach", checkout, record.preApplyRevision]);
    if (added.exitCode !== 0) throw new Error(`Could not create promotion preflight worktree: ${added.stderr}`);
    await transition(root, record, "preflighting", "Applying result closure in a temporary worktree.");
    for (const child of closure.filter((item) => item.changeArtifact?.resultRevision)) {
      const picked = await git(checkout, [...MANAGED_COMMIT_CONFIG, "cherry-pick", child.changeArtifact!.resultRevision!]);
      if (picked.exitCode !== 0) {
        record.conflictPaths = (await git(checkout, ["diff", "--name-only", "--diff-filter=U"])).stdout.split(/\r?\n/).filter(Boolean).sort();
        record.conflicts = conflictsFor(child, record.conflictPaths);
        record.failure = {
          category: "conflict", code: "PROMOTION_PREFLIGHT_CONFLICT", message: "The result conflicts in the temporary preflight worktree.",
          targetModified: false, rollbackAttempted: false, manualRecoveryRequired: false, recoveryCommands: []
        };
        await git(checkout, ["cherry-pick", "--abort"]);
        await transition(root, record, "conflicted", `Preflight conflict${record.conflictPaths.length ? `: ${record.conflictPaths.join(", ")}` : "."}`);
        return record;
      }
    }
    const soft = await git(checkout, ["reset", "--soft", record.preApplyRevision]);
    if (soft.exitCode !== 0) throw new Error(soft.stderr);
    const commit = await execa("git", ["commit", "--no-gpg-sign", "-m", `Apply Ariadne result ${run.runId}`], {
      cwd: checkout, reject: false, timeout: GIT_TIMEOUT_MS,
      env: { GIT_AUTHOR_NAME: "Ariadne", GIT_AUTHOR_EMAIL: "ariadne@local.invalid", GIT_COMMITTER_NAME: "Ariadne", GIT_COMMITTER_EMAIL: "ariadne@local.invalid" }
    });
    if (commit.exitCode !== 0) throw new Error(`Could not create promotion commit: ${commit.stderr}`);
    record.promotionCommit = (await git(checkout, ["rev-parse", "HEAD"])).stdout.trim();
    if ((await git(root, ["rev-parse", "HEAD"])).stdout.trim() !== record.preApplyRevision) throw new AriadneError({ category: "promotion_conflict", code: "PROMOTION_TARGET_MOVED", stage: "validated", message: "The target HEAD changed during preflight; primary checkout was not modified." });
    await transition(root, record, "applying", "Cherry-picking the preflighted squashed commit into the primary checkout.");
    const applied = await git(root, [...MANAGED_COMMIT_CONFIG, "cherry-pick", record.promotionCommit]);
    if (applied.exitCode !== 0) {
      record.conflictPaths = (await git(root, ["diff", "--name-only", "--diff-filter=U"])).stdout.split(/\r?\n/).filter(Boolean).sort();
      record.conflicts = conflictsFor(run, record.conflictPaths);
      const aborted = await git(root, ["cherry-pick", "--abort"]);
      const head = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
      const operation = await git(root, ["rev-parse", "--git-path", "CHERRY_PICK_HEAD"]);
      const cherryPickActive = operation.exitCode === 0 && await fs.pathExists(path.resolve(root, operation.stdout.trim()));
      const restored = aborted.exitCode === 0 && head === record.preApplyRevision && !cherryPickActive;
      record.failure = {
        category: "conflict", code: restored ? "PROMOTION_CONFLICT_ABORTED" : "PROMOTION_CONFLICT_RECOVERY_REQUIRED",
        message: restored ? "Unexpected primary-checkout conflict was aborted automatically." : "The conflicting cherry-pick could not be verified as restored.",
        targetModified: !restored, rollbackAttempted: true, rollbackSucceeded: restored,
        manualRecoveryRequired: !restored, recoveryCommands: restored ? [] : ["git cherry-pick --abort", "git status --short --branch"]
      };
      await transition(root, record, "conflicted", record.failure.message);
      return record;
    }
    record.postApplyRevision = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
    await transition(root, record, "succeeded", "Result closure applied as one commit.");
    return record;
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
    record.failure ??= {
      category: error instanceof AriadneError && error.code === "PROMOTION_PREVIEW_STALE" ? "stale-preview" : error instanceof AriadneError ? "ineligible" : "git",
      code: error instanceof AriadneError ? error.code : "PROMOTION_OPERATION_FAILED", message: record.error,
      targetModified: false, rollbackAttempted: false, manualRecoveryRequired: false, recoveryCommands: []
    };
    await transition(root, record, error instanceof AriadneError && error.category === "promotion_conflict" ? "conflicted" : "failed", record.error);
    if (error instanceof AriadneError) throw error;
    return record;
  } finally {
    const removed = await git(root, ["worktree", "remove", "--force", checkout]);
    record.cleanup = { ...record.cleanup, removed: removed.exitCode === 0 || !(await fs.pathExists(checkout)), ...(removed.exitCode !== 0 && await fs.pathExists(checkout) ? { error: removed.stderr.trim() } : {}) };
    if (record.cleanup.removed) await fs.remove(preflightRoot).catch(() => undefined);
    await persist(root, record);
  }
}

export async function applyResult(rootInput: string, idOrPath: string, expectedFingerprint?: string): Promise<PromotionRecord> {
  const root = await fs.realpath(rootInput).catch(() => path.resolve(rootInput));
  return withManagementLock(root, `apply ${idOrPath}`, () => applyResultUnlocked(root, idOrPath, expectedFingerprint));
}

async function discardResultUnlocked(rootInput: string, idOrPath: string): Promise<PromotionRecord> {
  const root = await fs.realpath(rootInput).catch(() => path.resolve(rootInput));
  const run = await loadManagedRun(root, idOrPath);
  if (!run.changeArtifact?.resultRef || !run.workspace?.repositoryId) throw new AriadneError({ category: "promotion_conflict", code: "RESULT_NOT_DISCARDABLE", stage: "validated", message: `Run ${run.runId} has no managed result ref.` });
  const identity = await repositoryIdentity(root);
  if (identity.repositoryId !== run.workspace.repositoryId) throw new AriadneError({ category: "promotion_conflict", code: "PROMOTION_REPOSITORY_MISMATCH", stage: "validated", message: "Result belongs to a different repository." });
  const state = await currentPromotionState(root, run.runId);
  if (state.applied) throw new AriadneError({ category: "promotion_conflict", code: "APPLIED_RESULT_CANNOT_BE_DISCARDED", stage: "validated", message: `Run ${run.runId} was already applied.` });
  if (state.discarded) return state.discarded;
  if (!run.changeArtifact.resultRevision || !await resultRefExists(root, run.changeArtifact.resultRevision, run.runId)) {
    throw new AriadneError({ category: "promotion_conflict", code: "RESULT_REF_MISSING", stage: "validated", message: `Managed result ref for run ${run.runId} is missing or does not match its recorded revision.` });
  }
  const history = await loadRunHistory(root);
  const dependent = history.records.find((loaded) => loaded.ok && !loaded.legacy && "runId" in loaded.run && loaded.run.workspace?.inheritedResults.some((item) => item.runId === run.runId) && loaded.run.changeArtifact?.applicable);
  if (dependent?.ok && "runId" in dependent.run) throw new AriadneError({ category: "promotion_conflict", code: "RESULT_REQUIRED_BY_DEPENDENT", stage: "validated", message: `Run ${run.runId} is still required by applicable dependent result ${dependent.run.runId}.` });
  const record = initial("discard", run, identity.repositoryId);
  await persist(root, record);
  const deleted = await git(root, ["update-ref", "-d", run.changeArtifact.resultRef]);
  if (deleted.exitCode !== 0) {
    record.error = deleted.stderr.trim();
    await transition(root, record, "failed", "Could not delete the managed result ref.");
    return record;
  }
  if (run.workspace.state === "retained" && run.workspace.workspaceId) {
    const workspace = await loadWorkspace(root, run.workspace.workspaceId).catch(() => undefined);
    if (workspace) {
      const cleaned = await removeWorkspace(root, workspace, "Discard removed the retained managed worktree.");
      record.discard = { resultRefRemoved: true, workspaceId: workspace.workspaceId, workspaceState: cleaned.state, historyPreserved: true };
    }
  }
  record.discard ??= { resultRefRemoved: true, historyPreserved: true };
  await transition(root, record, "discarded", "Managed result ref discarded; historical artifacts remain immutable.");
  return record;
}

export async function discardResult(rootInput: string, idOrPath: string): Promise<PromotionRecord> {
  const root = await fs.realpath(rootInput).catch(() => path.resolve(rootInput));
  return withManagementLock(root, `discard ${idOrPath}`, () => discardResultUnlocked(root, idOrPath));
}

export async function promotionStatus(root: string, idOrPath: string): Promise<{ runId: string; applicable: boolean; changeState?: string; promotion: "unapplied" | "applied" | "discarded"; events: PromotionRecord[] }> {
  const run = await loadManagedRun(root, idOrPath);
  const events = (await loadPromotions(root)).flatMap((item) => item.record && (item.record.runId === run.runId || item.record.includedRunIds.includes(run.runId)) ? [item.record] : []);
  return {
    runId: run.runId, applicable: run.changeArtifact?.applicable ?? false, changeState: run.changeArtifact?.state,
    promotion: events.some((item) => item.kind === "apply" && item.status === "succeeded") ? "applied" : events.some((item) => item.kind === "discard" && item.status === "discarded") ? "discarded" : "unapplied",
    events
  };
}
