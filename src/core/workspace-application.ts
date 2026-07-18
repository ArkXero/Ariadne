import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { AriadneError } from "./errors.js";
import { createManagementAction, loadManagementActions, persistManagementAction } from "./management-actions.js";
import { withManagementLock } from "./management-lock.js";
import { canonicalizePath, isPathInside } from "./path-containment.js";
import { listWorkspaces, loadWorkspace, removeWorkspace, repositoryIdentity } from "./workspace-manager.js";
import type { ManagementActionRecord, WorkspaceRecord } from "../types/index.js";

export interface WorkspaceDetail {
  workspaceId: string;
  runId: string;
  batchId: string;
  taskId: string;
  attempt: number;
  path: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  ageMs: number;
  sourceRevision: string;
  preparedRevision?: string;
  retention: string;
  retentionReason?: string;
  sizeBytes?: number;
  sizeTruncated: boolean;
  physicalState: "present" | "missing" | "unsafe";
  cleanupEligible: boolean;
  cleanupBlockers: string[];
  cleanupError?: string;
}

export interface WorkspaceCleanupPreview {
  workspaceId: string;
  eligible: boolean;
  blockers: string[];
  removes: string[];
  preserves: string[];
  estimatedBytes?: number;
  missingDirectory: boolean;
}

export interface WorkspaceCleanupResult {
  action: ManagementActionRecord;
  cleaned: WorkspaceDetail[];
  skipped: Array<{ workspaceId: string; reason: string }>;
  failed: Array<{ workspaceId: string; reason: string }>;
}

const MAX_SIZE_ENTRIES = 100_000;

function ownerAlive(record: WorkspaceRecord): boolean {
  if (record.owner.hostname !== os.hostname()) return false;
  try { process.kill(record.owner.pid, 0); return true; }
  catch (error) { return error instanceof Error && "code" in error && error.code === "EPERM"; }
}

async function directorySize(root: string): Promise<{ bytes?: number; truncated: boolean }> {
  let count = 0;
  let bytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (++count > MAX_SIZE_ENTRIES) return { bytes, truncated: true };
      const target = path.join(current, entry.name);
      const stat = await fs.lstat(target).catch(() => undefined);
      if (!stat) continue;
      bytes += stat.size;
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(target);
    }
  }
  return { bytes, truncated: false };
}

async function detail(root: string, record: WorkspaceRecord): Promise<WorkspaceDetail> {
  const expected = `.ariadne/worktrees/${record.workspaceId}/checkout`;
  const candidate = path.resolve(root, record.path);
  const candidateStat = await fs.lstat(candidate).catch(() => undefined);
  const safe = record.workspaceId.startsWith("ws-") && record.path === expected
    && isPathInside(root, await canonicalizePath(candidate)) && !candidateStat?.isSymbolicLink();
  const present = safe && Boolean(candidateStat);
  const physicalState: WorkspaceDetail["physicalState"] = !safe ? "unsafe" : present ? "present" : "missing";
  const blockers: string[] = [];
  if (!safe) blockers.push("Workspace identity or path is not provably Ariadne-managed.");
  if (["creating", "ready", "preparing", "running", "capturing", "removing"].includes(record.state) && ownerAlive(record) && record.owner.pid !== process.pid) blockers.push(`Workspace owner PID ${record.owner.pid} is active.`);
  if (!["retained", "stale", "failed", "removed"].includes(record.state) && blockers.length === 0) blockers.push(`State ${record.state} is not cleanup-eligible.`);
  const size = present ? await directorySize(candidate) : { truncated: false };
  return {
    workspaceId: record.workspaceId, runId: record.runId, batchId: record.batchId, taskId: record.taskId, attempt: record.attempt,
    path: record.path, state: physicalState === "missing" && record.state !== "removed" ? "missing" : record.state,
    createdAt: record.createdAt, updatedAt: record.updatedAt, ageMs: Math.max(0, Date.now() - Date.parse(record.updatedAt)),
    sourceRevision: record.sourceRevision, preparedRevision: record.preparedRevision, retention: record.retention,
    retentionReason: record.retentionReason, sizeBytes: size.bytes, sizeTruncated: size.truncated, physicalState,
    cleanupEligible: blockers.length === 0 && record.state !== "removed", cleanupBlockers: blockers, cleanupError: record.cleanupError
  };
}

export async function listManagedWorkspaces(rootInput: string): Promise<{ workspaces: WorkspaceDetail[]; warnings: string[]; cleanupFailures: number }> {
  const root = await fs.realpath(rootInput).catch(() => path.resolve(rootInput));
  const [items, actions] = await Promise.all([listWorkspaces(root), loadManagementActions(root)]);
  const records = items.flatMap((item) => item.record ? [item.record] : []);
  const workspaces = (await Promise.all(records.map((record) => detail(root, record)))).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.workspaceId.localeCompare(right.workspaceId));
  return {
    workspaces,
    warnings: [...items.flatMap((item) => item.warning ? [item.warning] : []), ...actions.flatMap((item) => item.warning ? [item.warning] : [])],
    cleanupFailures: workspaces.filter((workspace) => Boolean(workspace.cleanupError)).length
  };
}

export async function loadWorkspaceDetail(rootInput: string, workspaceId: string): Promise<WorkspaceDetail> {
  const root = await fs.realpath(rootInput).catch(() => path.resolve(rootInput));
  return detail(root, await loadWorkspace(root, workspaceId));
}

export async function previewWorkspaceCleanup(rootInput: string, workspaceId: string): Promise<WorkspaceCleanupPreview> {
  const root = await fs.realpath(rootInput).catch(() => path.resolve(rootInput));
  const value = await loadWorkspaceDetail(root, workspaceId);
  const identity = await repositoryIdentity(root);
  const record = await loadWorkspace(root, workspaceId);
  const blockers = [...value.cleanupBlockers];
  if (identity.repositoryId !== record.repositoryId) blockers.push("Workspace belongs to a different repository.");
  return {
    workspaceId, eligible: blockers.length === 0, blockers,
    removes: ["managed checkout directory", "matching Git worktree registration", "eligible temporary workspace resources"],
    preserves: ["run and batch records", "stdout and stderr artifacts", "reports", "change and promotion history", "workspace lifecycle metadata"],
    estimatedBytes: value.sizeBytes, missingDirectory: value.physicalState === "missing"
  };
}

export async function previewEligibleWorkspaceCleanup(rootInput: string): Promise<WorkspaceCleanupPreview> {
  const root = await fs.realpath(rootInput).catch(() => path.resolve(rootInput));
  const listed = await listManagedWorkspaces(root);
  const eligible = listed.workspaces.filter((workspace) => workspace.cleanupEligible);
  return {
    workspaceId: `${eligible.length} eligible workspace${eligible.length === 1 ? "" : "s"}`,
    eligible: eligible.length > 0,
    blockers: eligible.length > 0 ? [] : ["No managed workspaces currently pass cleanup ownership checks."],
    removes: eligible.map((workspace) => `${workspace.workspaceId}: managed checkout and matching Git worktree registration`),
    preserves: ["run and batch records", "stdout and stderr artifacts", "reports", "change, promotion, and workspace lifecycle history"],
    estimatedBytes: eligible.reduce((total, workspace) => total + (workspace.sizeBytes ?? 0), 0),
    missingDirectory: eligible.length > 0 && eligible.every((workspace) => workspace.physicalState === "missing")
  };
}

async function cleanOne(root: string, workspaceId: string): Promise<WorkspaceDetail> {
  const preview = await previewWorkspaceCleanup(root, workspaceId);
  if (!preview.eligible) throw new AriadneError({ category: "workspace_management", code: "WORKSPACE_NOT_CLEANABLE", stage: "workspace_cleanup", message: preview.blockers.join(" ") });
  const record = await removeWorkspace(root, await loadWorkspace(root, workspaceId), "Managed workspace cleanup application service.");
  const value = await detail(root, record);
  if (record.state !== "removed") throw new AriadneError({
    category: "workspace_management", code: "WORKSPACE_CLEANUP_INCOMPLETE", stage: "workspace_cleanup",
    message: record.cleanupError ?? `Workspace cleanup ended in state ${record.state}.`
  });
  return value;
}

async function cleanMany(root: string, workspaceIds: string[], signal?: AbortSignal, onProgress?: (stage: string) => void): Promise<WorkspaceCleanupResult> {
  const identity = await repositoryIdentity(root);
  const action = createManagementAction({ kind: "workspace-cleanup", repositoryId: identity.repositoryId, workspaceIds });
  const cleaned: WorkspaceDetail[] = [];
  const skipped: WorkspaceCleanupResult["skipped"] = [];
  const failed: WorkspaceCleanupResult["failed"] = [];
  for (const workspaceId of workspaceIds) {
    if (signal?.aborted) { action.status = "interrupted"; break; }
    onProgress?.(`cleaning ${workspaceId}`);
    try {
      const preview = await previewWorkspaceCleanup(root, workspaceId);
      if (!preview.eligible) {
        const reason = preview.blockers.join(" "); skipped.push({ workspaceId, reason });
        action.outcomes.push({ resourceId: workspaceId, status: "skipped", detail: reason });
        continue;
      }
      const value = await cleanOne(root, workspaceId);
      cleaned.push(value); action.outcomes.push({ resourceId: workspaceId, status: "succeeded", detail: `Workspace state: ${value.state}.` });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failed.push({ workspaceId, reason }); action.outcomes.push({ resourceId: workspaceId, status: "failed", detail: reason });
    }
  }
  if (action.status !== "interrupted") action.status = failed.length > 0 || skipped.length > 0 ? "partial" : "succeeded";
  if (failed.length > 0) action.error = failed.map((item) => `${item.workspaceId}: ${item.reason}`).join("; ");
  await persistManagementAction(root, action);
  return { action, cleaned, skipped, failed };
}

export async function cleanWorkspace(rootInput: string, workspaceId: string, options: { signal?: AbortSignal; onProgress?: (stage: string) => void } = {}): Promise<WorkspaceCleanupResult> {
  const root = await fs.realpath(rootInput).catch(() => path.resolve(rootInput));
  return withManagementLock(root, `clean ${workspaceId}`, () => cleanMany(root, [workspaceId], options.signal, options.onProgress));
}

export async function cleanEligibleWorkspaces(rootInput: string, options: { signal?: AbortSignal; onProgress?: (stage: string) => void } = {}): Promise<WorkspaceCleanupResult> {
  const root = await fs.realpath(rootInput).catch(() => path.resolve(rootInput));
  const listed = await listManagedWorkspaces(root);
  const ids = listed.workspaces.filter((workspace) => workspace.cleanupEligible).map((workspace) => workspace.workspaceId);
  return withManagementLock(root, "clean eligible workspaces", () => cleanMany(root, ids, options.signal, options.onProgress));
}
