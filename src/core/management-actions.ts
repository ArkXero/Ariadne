import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { atomicWriteJson } from "./atomic.js";
import { ManagementActionRecordSchema } from "../schema/management-action-record.js";
import {
  CURRENT_MANAGEMENT_ACTION_SCHEMA_VERSION,
  type ManagementActionRecord
} from "../types/index.js";

function actionsRoot(root: string): string {
  return path.join(root, ".ariadne", "actions");
}

export function createManagementAction(options: {
  kind: ManagementActionRecord["kind"];
  repositoryId: string;
  runId?: string;
  workspaceIds?: string[];
  destination?: string;
}): ManagementActionRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: CURRENT_MANAGEMENT_ACTION_SCHEMA_VERSION,
    actionId: `${now.replace(/[-:.]/g, "")}-${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`,
    kind: options.kind,
    status: "running",
    repositoryId: options.repositoryId,
    startedAt: now,
    completedAt: now,
    owner: { pid: process.pid, hostname: os.hostname(), startedAt: now },
    ...(options.runId ? { runId: options.runId } : {}),
    workspaceIds: options.workspaceIds ?? [],
    ...(options.destination ? { destination: options.destination } : {}),
    outcomes: []
  };
}

export async function persistManagementAction(root: string, record: ManagementActionRecord): Promise<void> {
  record.completedAt = new Date().toISOString();
  const parsed = ManagementActionRecordSchema.safeParse(record);
  if (!parsed.success) throw new Error(`Invalid management action: ${parsed.error.message}`);
  await atomicWriteJson(path.join(actionsRoot(root), `${record.actionId}.json`), parsed.data);
}

export async function loadManagementActions(root: string): Promise<Array<{ path: string; record?: ManagementActionRecord; warning?: string }>> {
  const directory = actionsRoot(root);
  const files = (await fs.readdir(directory).catch(() => [] as string[])).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(files.map(async (name) => {
    const filePath = path.join(directory, name);
    const parsed = ManagementActionRecordSchema.safeParse(await fs.readJson(filePath).catch(() => undefined));
    return parsed.success ? { path: filePath, record: parsed.data } : { path: filePath, warning: `Management action record is corrupt: ${filePath}` };
  }));
}
