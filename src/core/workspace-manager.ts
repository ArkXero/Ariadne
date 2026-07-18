import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { execa } from "execa";
import fs from "fs-extra";
import { atomicWriteJson } from "./atomic.js";
import { AriadneError } from "./errors.js";
import { WorkspaceRecordSchema } from "../schema/workspace-record.js";
import {
  CURRENT_WORKSPACE_SCHEMA_VERSION,
  type RunOwner,
  type WorkspaceRecord,
  type WorkspaceState,
  type WorktreeRetention
} from "../types/index.js";

const GIT_TIMEOUT_MS = 30_000;

interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function git(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<GitResult> {
  try {
    const result = await execa("git", args, { cwd, reject: false, timeout, stripFinalNewline: false });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 0 };
  } catch (error) {
    return { stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 127 };
  }
}

function posixRelative(root: string, value: string): string {
  return path.relative(root, value).split(path.sep).join("/");
}

function owner(now = new Date()): RunOwner {
  return { pid: process.pid, hostname: os.hostname(), startedAt: now.toISOString() };
}

export function createWorkspaceId(runId: string): string {
  return `ws-${runId.replace(/[^A-Za-z0-9._-]/g, "-")}`;
}

export async function repositoryIdentity(projectRoot: string): Promise<{ repositoryId: string; sourceRevision: string; branch?: string }> {
  const [common, revision, branch] = await Promise.all([
    git(projectRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(projectRoot, ["rev-parse", "--verify", "HEAD^{commit}"]),
    git(projectRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"])
  ]);
  if (common.exitCode !== 0 || revision.exitCode !== 0) {
    throw new AriadneError({
      category: "workspace_management", code: "WORKTREE_GIT_REQUIRED", stage: "workspace_creating",
      message: "Worktree isolation requires a Git repository with at least one commit.",
      correction: "Commit the source revision or use --isolation shared.", details: { git: common.stderr || revision.stderr }
    });
  }
  const commonPath = await fs.realpath(common.stdout.trim()).catch(() => path.resolve(projectRoot, common.stdout.trim()));
  return {
    repositoryId: crypto.createHash("sha256").update(commonPath).digest("hex"),
    sourceRevision: revision.stdout.trim(),
    ...(branch.exitCode === 0 ? { branch: branch.stdout.trim() } : {})
  };
}

function workspacePaths(projectRoot: string, workspaceId: string): { root: string; checkout: string; metadata: string } {
  const root = path.join(projectRoot, ".ariadne", "worktrees", workspaceId);
  return { root, checkout: path.join(root, "checkout"), metadata: path.join(root, "workspace.json") };
}

async function persistWorkspace(projectRoot: string, record: WorkspaceRecord): Promise<void> {
  record.updatedAt = new Date().toISOString();
  const parsed = WorkspaceRecordSchema.safeParse(record);
  if (!parsed.success) {
    throw new AriadneError({
      category: "persistence", code: "WORKSPACE_RECORD_INVALID", stage: "persisting",
      message: `Refusing to persist invalid workspace metadata: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}.`,
      details: { issues: parsed.error.issues }
    });
  }
  await atomicWriteJson(path.join(projectRoot, record.metadataPath), parsed.data);
}

export async function transitionWorkspace(projectRoot: string, record: WorkspaceRecord, state: WorkspaceState, detail?: string): Promise<void> {
  record.state = state;
  record.lifecycle.push({ state, at: new Date().toISOString(), ...(detail ? { detail } : {}) });
  await persistWorkspace(projectRoot, record);
}

export async function createWorkspace(options: {
  projectRoot: string;
  workspaceId: string;
  runId: string;
  batchId: string;
  planId: string;
  taskId: string;
  attempt: number;
  repositoryId: string;
  sourceRevision: string;
  retention: WorktreeRetention;
}): Promise<WorkspaceRecord> {
  const paths = workspacePaths(options.projectRoot, options.workspaceId);
  await fs.ensureDir(path.dirname(paths.root));
  try {
    await mkdir(paths.root, { recursive: false, mode: 0o700 });
  } catch (error) {
    throw new AriadneError({
      category: "workspace_management", code: "WORKSPACE_ID_COLLISION", stage: "workspace_creating", source: paths.root,
      message: `Managed workspace ${options.workspaceId} already exists or could not be created.`, correction: "Retry so Ariadne creates a fresh workspace ID.", cause: error
    });
  }
  const now = new Date();
  const record: WorkspaceRecord = {
    schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
    workspaceId: options.workspaceId,
    runId: options.runId,
    batchId: options.batchId,
    planId: options.planId,
    taskId: options.taskId,
    attempt: options.attempt,
    repositoryId: options.repositoryId,
    sourceRevision: options.sourceRevision,
    path: posixRelative(options.projectRoot, paths.checkout),
    metadataPath: posixRelative(options.projectRoot, paths.metadata),
    state: "creating",
    retention: options.retention,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    owner: owner(now),
    lifecycle: [{ state: "creating", at: now.toISOString(), detail: `Creating detached worktree from ${options.sourceRevision}.` }]
  };
  await persistWorkspace(options.projectRoot, record);
  const added = await git(options.projectRoot, ["worktree", "add", "--detach", paths.checkout, options.sourceRevision]);
  if (added.exitCode !== 0) {
    await transitionWorkspace(options.projectRoot, record, "failed", added.stderr.trim() || "git worktree add failed.");
    throw new AriadneError({
      category: "workspace_management", code: "WORKTREE_CREATE_FAILED", stage: "workspace_creating", source: paths.checkout,
      message: "Git could not create the isolated worktree.", correction: "Run git worktree prune, inspect the diagnostic, and retry.",
      details: { stderr: added.stderr.trim() }
    });
  }
  await transitionWorkspace(options.projectRoot, record, "ready", "Detached worktree is ready.");
  return record;
}

export async function layerResultCommits(projectRoot: string, record: WorkspaceRecord, revisions: string[]): Promise<string> {
  const checkout = path.join(projectRoot, record.path);
  for (const revision of revisions) {
    const picked = await git(checkout, ["cherry-pick", revision]);
    if (picked.exitCode !== 0) {
      await git(checkout, ["cherry-pick", "--abort"]);
      await transitionWorkspace(projectRoot, record, "failed", `Dependency result ${revision} could not be layered.`);
      throw new AriadneError({
        category: "workspace_preparation", code: "DEPENDENCY_RESULT_CONFLICT", stage: "preparing",
        message: `Dependency result ${revision} conflicts while preparing ${record.taskId}.`,
        correction: "Inspect the dependency results and rerun with compatible changes.", details: { stderr: picked.stderr.trim() }
      });
    }
  }
  const revision = await git(checkout, ["rev-parse", "HEAD"]);
  if (revision.exitCode !== 0) throw new AriadneError({ category: "workspace_management", code: "PREPARED_REVISION_FAILED", stage: "preparing", message: "Could not resolve the prepared worktree revision." });
  record.preparedRevision = revision.stdout.trim();
  await persistWorkspace(projectRoot, record);
  return record.preparedRevision;
}

async function registeredWorktree(projectRoot: string, checkout: string): Promise<boolean> {
  const list = await git(projectRoot, ["worktree", "list", "--porcelain"]);
  if (list.exitCode !== 0) return false;
  const expected = await fs.realpath(checkout).catch(() => path.resolve(checkout));
  const paths = list.stdout.split(/\r?\n/).filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9));
  for (const candidate of paths) if (await fs.realpath(candidate).catch(() => path.resolve(candidate)) === expected) return true;
  return false;
}

export async function removeWorkspace(projectRoot: string, record: WorkspaceRecord, detail = "Managed worktree cleanup requested."): Promise<WorkspaceRecord> {
  const identity = await repositoryIdentity(projectRoot);
  if (identity.repositoryId !== record.repositoryId) {
    throw new AriadneError({ category: "workspace_management", code: "WORKSPACE_REPOSITORY_MISMATCH", stage: "workspace_cleanup", message: "Workspace metadata belongs to a different repository; refusing removal." });
  }
  if (!record.workspaceId.startsWith("ws-")) {
    throw new AriadneError({ category: "workspace_management", code: "WORKSPACE_NAME_UNSAFE", stage: "workspace_cleanup", message: "Workspace does not use the Ariadne-managed naming convention; refusing removal." });
  }
  if (["creating", "ready", "preparing", "running", "capturing", "removing"].includes(record.state) && record.owner.hostname === os.hostname() && record.owner.pid !== process.pid) {
    let alive = false;
    try { process.kill(record.owner.pid, 0); alive = true; } catch (error) { alive = error instanceof Error && "code" in error && error.code === "EPERM"; }
    if (alive) throw new AriadneError({ category: "workspace_management", code: "WORKSPACE_OWNER_ACTIVE", stage: "workspace_cleanup", message: `Workspace owner PID ${record.owner.pid} is still active; refusing removal.` });
  }
  const expectedPrefix = `.ariadne/worktrees/${record.workspaceId}/checkout`;
  if (record.path !== expectedPrefix) {
    throw new AriadneError({ category: "workspace_management", code: "WORKSPACE_PATH_UNSAFE", stage: "workspace_cleanup", message: "Workspace metadata contains an unexpected checkout path; refusing removal.", details: { path: record.path } });
  }
  await transitionWorkspace(projectRoot, record, "removing", detail);
  const checkout = path.join(projectRoot, record.path);
  if (await registeredWorktree(projectRoot, checkout)) {
    const removed = await git(projectRoot, ["worktree", "remove", "--force", checkout]);
    if (removed.exitCode !== 0) {
      record.cleanupError = removed.stderr.trim() || "git worktree remove failed.";
      await transitionWorkspace(projectRoot, record, "retained", "Cleanup failed; workspace retained.");
      return record;
    }
  } else if (await fs.pathExists(checkout)) {
    try {
      await fs.remove(checkout);
    } catch (error) {
      record.cleanupError = error instanceof Error ? error.message : String(error);
      await transitionWorkspace(projectRoot, record, "retained", "Unregistered managed checkout could not be removed; workspace retained.");
      return record;
    }
  }
  if (await fs.pathExists(checkout)) {
    record.cleanupError = "Managed checkout still exists after cleanup.";
    await transitionWorkspace(projectRoot, record, "retained", "Cleanup verification failed; workspace retained.");
    return record;
  }
  record.cleanupAt = new Date().toISOString();
  await transitionWorkspace(projectRoot, record, "removed", "Managed checkout removed.");
  return record;
}

export async function loadWorkspace(projectRoot: string, workspaceIdOrPath: string): Promise<WorkspaceRecord> {
  const metadata = workspaceIdOrPath.endsWith(".json")
    ? path.resolve(projectRoot, workspaceIdOrPath)
    : workspacePaths(projectRoot, workspaceIdOrPath).metadata;
  const parsed = WorkspaceRecordSchema.safeParse(await fs.readJson(metadata).catch(() => undefined));
  if (!parsed.success) throw new AriadneError({ category: "workspace_management", code: "WORKSPACE_RECORD_UNREADABLE", stage: "loading", source: metadata, message: "Workspace metadata is missing or corrupt.", details: { issues: parsed.error.issues } });
  return parsed.data;
}

export async function listWorkspaces(projectRoot: string): Promise<Array<{ record?: WorkspaceRecord; metadataPath: string; warning?: string }>> {
  const root = path.join(projectRoot, ".ariadne", "worktrees");
  const names = await fs.readdir(root).catch(() => [] as string[]);
  const results = await Promise.all(names.sort().map(async (name) => {
    const metadataPath = path.join(root, name, "workspace.json");
    try {
      const record = await loadWorkspace(projectRoot, metadataPath);
      if (["creating", "ready", "preparing", "running", "capturing", "removing"].includes(record.state) && record.owner.hostname === os.hostname()) {
        let alive = false;
        try { process.kill(record.owner.pid, 0); alive = true; } catch (error) { alive = error instanceof Error && "code" in error && error.code === "EPERM"; }
        if (!alive) return { record: { ...record, state: "stale" as const }, metadataPath, warning: `Owner PID ${record.owner.pid} is no longer alive; displayed as stale without rewriting metadata.` };
      }
      return { record, metadataPath };
    }
    catch (error) { return { metadataPath, warning: error instanceof Error ? error.message : String(error) }; }
  }));
  return results;
}

export async function resultRefExists(projectRoot: string, revision: string, runId: string): Promise<boolean> {
  const result = await git(projectRoot, ["show-ref", "--verify", `refs/ariadne/results/${runId}`]);
  return result.exitCode === 0 && result.stdout.trim().split(/\s+/)[0] === revision;
}
