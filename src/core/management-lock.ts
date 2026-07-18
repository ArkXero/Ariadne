import os from "node:os";
import path from "node:path";
import { open } from "node:fs/promises";
import fs from "fs-extra";
import { AriadneError } from "./errors.js";

interface LockOwner {
  pid: number;
  hostname: string;
  startedAt: string;
  operation: string;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error instanceof Error && "code" in error && error.code === "EPERM"; }
}

export async function withManagementLock<T>(root: string, operation: string, action: () => Promise<T>): Promise<T> {
  const lockPath = path.join(root, ".ariadne", "locks", "management.json");
  await fs.ensureDir(path.dirname(lockPath));
  const owner: LockOwner = { pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString(), operation };
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    const current = await fs.readJson(lockPath).catch(() => undefined) as Partial<LockOwner> | undefined;
    if (current?.hostname === os.hostname() && typeof current.pid === "number" && !alive(current.pid)) {
      await fs.remove(lockPath);
      handle = await open(lockPath, "wx", 0o600);
    } else {
      throw new AriadneError({
        category: "promotion_conflict", code: "MANAGEMENT_ACTION_ACTIVE", stage: "validated",
        message: `Another Ariadne management action is active${current?.operation ? `: ${current.operation}` : "."}`,
        correction: "Wait for it to finish before applying, discarding, exporting, or cleaning workspaces.", cause: error
      });
    }
  }
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`);
    return await action();
  } finally {
    await handle.close().catch(() => undefined);
    await fs.remove(lockPath).catch(() => undefined);
  }
}
