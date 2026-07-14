import crypto from "node:crypto";
import path from "node:path";
import { open, rename, rm } from "node:fs/promises";
import fs from "fs-extra";

export async function atomicWriteFile(filePath: string, contents: string | Buffer): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(temporaryPath, filePath);
    if (process.platform !== "win32") {
      const directory = await open(path.dirname(filePath), "r").catch(() => undefined);
      if (directory) {
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    }
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
