import path from "node:path";
import fs from "fs-extra";
import { listWorkspaces, loadWorkspace, removeWorkspace } from "../core/workspace-manager.js";

export async function worktreeListCommand(cwd: string, json = false): Promise<void> {
  const root = await fs.realpath(cwd).catch(() => path.resolve(cwd));
  const values = await listWorkspaces(root);
  const payload = values.map((item) => item.record ? {
    workspaceId: item.record.workspaceId, taskId: item.record.taskId, runId: item.record.runId, state: item.record.state,
    retention: item.record.retention, path: item.record.path
  } : { metadataPath: path.relative(root, item.metadataPath).split(path.sep).join("/"), warning: item.warning });
  if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(["Ariadne worktrees", "", ...payload.map((item) => "workspaceId" in item ? `${item.workspaceId}  ${item.state}  ${item.taskId}  ${item.path}` : `WARN  ${item.metadataPath}: ${item.warning}`)].join("\n") + "\n");
}

export async function worktreeRemoveCommand(cwd: string, workspaceId: string, json = false): Promise<void> {
  const root = await fs.realpath(cwd).catch(() => path.resolve(cwd));
  const record = await removeWorkspace(root, await loadWorkspace(root, workspaceId), "Explicit worktree remove command.");
  process.stdout.write(json ? `${JSON.stringify(record, null, 2)}\n` : `Workspace ${record.workspaceId}: ${record.state}${record.cleanupError ? ` (${record.cleanupError})` : ""}\n`);
}

export async function worktreeCleanCommand(cwd: string, dryRun = false, json = false): Promise<void> {
  const root = await fs.realpath(cwd).catch(() => path.resolve(cwd));
  const values = await listWorkspaces(root);
  const actions: Array<{ workspaceId?: string; action: string; result?: string; warning?: string }> = [];
  for (const item of values) {
    if (!item.record) { actions.push({ action: "skip", warning: item.warning }); continue; }
    if (!["retained", "stale", "failed"].includes(item.record.state)) { actions.push({ workspaceId: item.record.workspaceId, action: "skip", result: `state ${item.record.state} is not cleanable` }); continue; }
    if (dryRun) actions.push({ workspaceId: item.record.workspaceId, action: "remove", result: "dry-run" });
    else {
      const result = await removeWorkspace(root, item.record, "Managed worktree clean command.");
      actions.push({ workspaceId: item.record.workspaceId, action: "remove", result: result.state, ...(result.cleanupError ? { warning: result.cleanupError } : {}) });
    }
  }
  process.stdout.write(json ? `${JSON.stringify(actions, null, 2)}\n` : [dryRun ? "Ariadne worktree clean (dry run)" : "Ariadne worktree clean", "", ...actions.map((item) => `${item.action.toUpperCase()}  ${item.workspaceId ?? "unknown"}  ${item.result ?? item.warning ?? ""}`)].join("\n") + "\n");
}

