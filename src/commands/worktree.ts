import path from "node:path";
import fs from "fs-extra";
import { wrapHostileLines } from "../core/terminal-sanitize.js";
import {
  cleanEligibleWorkspaces, cleanWorkspace, listManagedWorkspaces, previewWorkspaceCleanup
} from "../core/workspace-application.js";

export async function worktreeListCommand(cwd: string, json = false): Promise<void> {
  const root = await fs.realpath(cwd).catch(() => path.resolve(cwd));
  const values = await listManagedWorkspaces(root);
  const payload: Array<{ workspaceId?: string; taskId?: string; runId?: string; state?: string; retention?: string; path?: string; warning?: string }> = values.workspaces.map((item) => ({
    workspaceId: item.workspaceId, taskId: item.taskId, runId: item.runId, state: item.state,
    retention: item.retention, path: item.path
  }));
  payload.push(...values.warnings.map((warning) => ({ warning })));
  if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(wrapHostileLines(["Ariadne worktrees", "", ...payload.map((item) => item.workspaceId ? `${item.workspaceId}  ${item.state}  ${item.taskId}  ${item.path}` : `WARN  ${item.warning}`)].join("\n"), 240) + "\n");
}

export async function worktreeRemoveCommand(cwd: string, workspaceId: string, json = false): Promise<void> {
  const root = await fs.realpath(cwd).catch(() => path.resolve(cwd));
  const result = await cleanWorkspace(root, workspaceId);
  const record = result.cleaned[0];
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : wrapHostileLines(record ? `Workspace ${record.workspaceId}: ${record.state}${record.cleanupError ? ` (${record.cleanupError})` : ""}` : `Workspace ${workspaceId}: ${result.skipped[0]?.reason ?? result.failed[0]?.reason ?? "not cleaned"}`, 240) + "\n");
}

export async function worktreeCleanCommand(cwd: string, dryRun = false, json = false): Promise<void> {
  const root = await fs.realpath(cwd).catch(() => path.resolve(cwd));
  const values = await listManagedWorkspaces(root);
  const actions: Array<{ workspaceId?: string; action: string; result?: string; warning?: string }> = [];
  if (dryRun) {
    for (const item of values.workspaces) {
      const preview = await previewWorkspaceCleanup(root, item.workspaceId);
      actions.push(preview.eligible ? { workspaceId: item.workspaceId, action: "remove", result: "dry-run" } : { workspaceId: item.workspaceId, action: "skip", result: preview.blockers.join(" ") });
    }
  } else {
    const result = await cleanEligibleWorkspaces(root);
    actions.push(...result.cleaned.map((item) => ({ workspaceId: item.workspaceId, action: "remove", result: item.state })));
    actions.push(...result.skipped.map((item) => ({ workspaceId: item.workspaceId, action: "skip", result: item.reason })));
    actions.push(...result.failed.map((item) => ({ workspaceId: item.workspaceId, action: "remove", result: "failed", warning: item.reason })));
  }
  actions.push(...values.warnings.map((warning) => ({ action: "skip", warning })));
  process.stdout.write(json ? `${JSON.stringify(actions, null, 2)}\n` : wrapHostileLines([dryRun ? "Ariadne worktree clean (dry run)" : "Ariadne worktree clean", "", ...actions.map((item) => `${item.action.toUpperCase()}  ${item.workspaceId ?? "unknown"}  ${item.result ?? item.warning ?? ""}`)].join("\n"), 240) + "\n");
}
