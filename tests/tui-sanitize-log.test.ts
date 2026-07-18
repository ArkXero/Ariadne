import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_LOG_PREVIEW_BYTES, readLogPreview } from "../src/tui/log-preview.js";
import { sanitizeTerminalText, truncateDisplay, wrapHostileLines } from "../src/tui/sanitize.js";
import { cleanupTempDirs, tempDir } from "./helpers.js";

afterEach(cleanupTempDirs);

describe("TUI terminal text sanitization", () => {
  it("removes CSI color and cursor movement sequences", () => {
    expect(sanitizeTerminalText("\u001B[31mred\u001B[0m\u001B[2Jdone")).toBe("reddone");
  });

  it("removes OSC hyperlinks while preserving their visible label", () => {
    expect(sanitizeTerminalText("\u001B]8;;https://example.test\u0007label\u001B]8;;\u0007")).toBe("label");
  });

  it("normalizes carriage returns and strips C0 and C1 controls", () => {
    expect(sanitizeTerminalText("one\rtwo\u0000\u0085three")).toBe("one\ntwothree");
  });

  it("preserves harmless literal markup", () => {
    expect(sanitizeTerminalText("<script>alert('literal')</script>")).toContain("<script>");
  });

  it("truncates by Unicode display width", () => {
    expect(truncateDisplay("界界界", 5)).toBe("界界…");
  });

  it("wraps unbroken hostile text without dropping content", () => {
    const wrapped = wrapHostileLines("x".repeat(25), 10);
    expect(wrapped.split("\n").map((line) => line.length)).toEqual([10, 10, 5]);
  });
});

describe("bounded log previews", () => {
  it("reads a small UTF-8 log", async () => {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, "logs"));
    await writeFile(path.join(cwd, "logs", "stdout.log"), "hello\nworld\n");
    const result = await readLogPreview(cwd, "logs/stdout.log");
    expect(result).toMatchObject({ status: "ready", text: "hello\nworld\n", truncated: false, totalBytes: 12 });
  });

  it("reads only the final 64 KiB and starts at a complete line", async () => {
    const cwd = await tempDir();
    const prefix = `partial-${"x".repeat(MAX_LOG_PREVIEW_BYTES)}\n`;
    await writeFile(path.join(cwd, "large.log"), `${prefix}complete-one\ncomplete-two\n`);
    const result = await readLogPreview(cwd, "large.log");
    expect(result.truncated).toBe(true);
    expect(result.readBytes).toBe(MAX_LOG_PREVIEW_BYTES);
    expect(result.text.startsWith("complete-one")).toBe(true);
  });

  it("detects binary-looking output", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "binary.log"), Buffer.from([0, 1, 2, 3, 4]));
    expect(await readLogPreview(cwd, "binary.log")).toMatchObject({ status: "binary", text: "" });
  });

  it("bounds a large unbroken text line instead of dropping it", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "unbroken.log"), "z".repeat(MAX_LOG_PREVIEW_BYTES + 1_000));
    const result = await readLogPreview(cwd, "unbroken.log");
    expect(result.text.startsWith("Partial line at preview start\n")).toBe(true);
    expect(Math.max(...result.text.split("\n").map((line) => line.length))).toBeLessThanOrEqual(240);
  });

  it("reports missing files without throwing", async () => {
    const cwd = await tempDir();
    expect(await readLogPreview(cwd, "missing.log")).toMatchObject({ status: "missing" });
  });

  it("refuses path traversal", async () => {
    const cwd = await tempDir();
    expect(await readLogPreview(cwd, "../outside.log")).toMatchObject({ status: "unsafe" });
  });

  it("refuses a symlink that resolves outside the project", async () => {
    if (process.platform === "win32") return;
    const cwd = await tempDir();
    const outside = await tempDir();
    await writeFile(path.join(outside, "log.txt"), "outside\n");
    const { symlink } = await import("node:fs/promises");
    await symlink(path.join(outside, "log.txt"), path.join(cwd, "log.txt"));
    expect(await readLogPreview(cwd, "log.txt")).toMatchObject({ status: "unsafe" });
  });

  it("sanitizes terminal controls in file content", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "hostile.log"), "\u001B[31mFAIL\u001B[0m\rPASS\n");
    const result = await readLogPreview(cwd, "hostile.log");
    expect(result.text).toBe("FAIL\nPASS\n");
    expect(result.text).not.toContain("\u001B");
  });
});
