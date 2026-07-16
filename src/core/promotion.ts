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
import { loadWorkspace, removeWorkspace, repositoryIdentity, resultRefExists } from "./workspace-manager.js";
import { PromotionRecordSchema } from "../schema/promotion-record.js";
import {
  CURRENT_PROMOTION_SCHEMA_VERSION,
  type BatchRecord,
  type PromotionRecord,
  type RunRecord
} from "../types/index.js";

const GIT_TIMEOUT_MS = 30_000;

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
  return Promise.all(files.map(async (name) => {
    const filePath = path.join(directory, name);
    const parsed = PromotionRecordSchema.safeParse(await fs.readJson(filePath).catch(() => undefined));
    return parsed.success ? { path: filePath, record: parsed.data } : { path: filePath, warning: `Promotion record is corrupt: ${filePath}` };
  }));
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

export async function applyResult(rootInput: string, idOrPath: string): Promise<PromotionRecord> {
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
      const picked = await git(checkout, ["cherry-pick", child.changeArtifact!.resultRevision!]);
      if (picked.exitCode !== 0) {
        record.conflictPaths = (await git(checkout, ["diff", "--name-only", "--diff-filter=U"])).stdout.split(/\r?\n/).filter(Boolean).sort();
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
    const applied = await git(root, ["cherry-pick", record.promotionCommit]);
    if (applied.exitCode !== 0) {
      record.conflictPaths = (await git(root, ["diff", "--name-only", "--diff-filter=U"])).stdout.split(/\r?\n/).filter(Boolean).sort();
      await git(root, ["cherry-pick", "--abort"]);
      await transition(root, record, "conflicted", "Unexpected primary-checkout conflict was aborted automatically.");
      return record;
    }
    record.postApplyRevision = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
    await transition(root, record, "succeeded", "Result closure applied as one commit.");
    return record;
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
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

export async function discardResult(rootInput: string, idOrPath: string): Promise<PromotionRecord> {
  const root = await fs.realpath(rootInput).catch(() => path.resolve(rootInput));
  const run = await loadManagedRun(root, idOrPath);
  if (!run.changeArtifact?.resultRef || !run.workspace?.repositoryId) throw new AriadneError({ category: "promotion_conflict", code: "RESULT_NOT_DISCARDABLE", stage: "validated", message: `Run ${run.runId} has no managed result ref.` });
  const identity = await repositoryIdentity(root);
  if (identity.repositoryId !== run.workspace.repositoryId) throw new AriadneError({ category: "promotion_conflict", code: "PROMOTION_REPOSITORY_MISMATCH", stage: "validated", message: "Result belongs to a different repository." });
  const state = await currentPromotionState(root, run.runId);
  if (state.applied) throw new AriadneError({ category: "promotion_conflict", code: "APPLIED_RESULT_CANNOT_BE_DISCARDED", stage: "validated", message: `Run ${run.runId} was already applied.` });
  if (state.discarded) throw new AriadneError({ category: "promotion_conflict", code: "RESULT_ALREADY_DISCARDED", stage: "validated", message: `Run ${run.runId} was already discarded.` });
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
    if (workspace) await removeWorkspace(root, workspace, "Discard removed the retained managed worktree.");
  }
  await transition(root, record, "discarded", "Managed result ref discarded; historical artifacts remain immutable.");
  return record;
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
