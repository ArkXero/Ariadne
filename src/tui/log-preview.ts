import path from "node:path";
import { open } from "node:fs/promises";
import fs from "fs-extra";
import { canonicalizePath, isPathInside } from "../core/path-containment.js";
import { wrapHostileLines } from "./sanitize.js";
import type { LogPreview } from "./types.js";

export const MAX_LOG_PREVIEW_BYTES = 64 * 1024;

function preview(pathValue: string, status: LogPreview["status"], message: string): LogPreview {
  return { path: pathValue, status, text: "", totalBytes: 0, readBytes: 0, truncated: false, message };
}

function looksBinary(buffer: Buffer): boolean {
  if (buffer.includes(0)) return true;
  if (buffer.length === 0) return false;
  let suspicious = 0;
  for (const byte of buffer) if ((byte < 9 && byte !== 7) || (byte > 13 && byte < 32 && byte !== 27)) suspicious += 1;
  return suspicious / buffer.length > 0.08;
}

export async function readLogPreview(projectRoot: string, relativePath: string): Promise<LogPreview> {
  const root = await canonicalizePath(projectRoot);
  const candidate = path.resolve(root, relativePath);
  const resolved = await canonicalizePath(candidate);
  if (!isPathInside(root, resolved)) return preview(relativePath, "unsafe", "Artifact path leaves the project root.");
  let stat;
  try {
    stat = await fs.stat(candidate);
  } catch (error) {
    return preview(relativePath, (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable", error instanceof Error ? error.message : String(error));
  }
  if (!stat.isFile()) return preview(relativePath, "unreadable", "Artifact is not a regular file.");
  const totalBytes = stat.size;
  const offset = Math.max(0, totalBytes - MAX_LOG_PREVIEW_BYTES);
  const length = Math.min(totalBytes, MAX_LOG_PREVIEW_BYTES);
  const buffer = Buffer.alloc(length);
  try {
    const handle = await open(candidate, "r");
    let bytesRead = 0;
    try {
      ({ bytesRead } = await handle.read(buffer, 0, length, offset));
    } finally {
      await handle.close();
    }
    const data = buffer.subarray(0, bytesRead);
    if (looksBinary(data)) return { path: relativePath, status: "binary", text: "", totalBytes, readBytes: bytesRead, truncated: offset > 0, message: "Binary-looking output is not rendered." };
    let text = data.toString("utf8");
    if (offset > 0) {
      const firstCompleteLine = text.indexOf("\n");
      text = firstCompleteLine === -1 ? `Partial line at preview start\n${text}` : text.slice(firstCompleteLine + 1);
    }
    return { path: relativePath, status: "ready", text: wrapHostileLines(text), totalBytes, readBytes: bytesRead, truncated: offset > 0 };
  } catch (error) {
    return { path: relativePath, status: "unreadable", text: "", totalBytes, readBytes: 0, truncated: false, message: error instanceof Error ? error.message : String(error) };
  }
}
