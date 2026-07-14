import path from "node:path";
import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import { execa, type ResultPromise } from "execa";
import fs from "fs-extra";
import { actualCommand, persistedCommand, redactShellCommand } from "./command-utils.js";
import type { OutputPreview, ProcessCleanupResult, ProcessResult, ProcessSpec } from "../types/index.js";

const HEAD_BYTES = 4 * 1024;
const TAIL_BYTES = 12 * 1024;

class PreviewCollector {
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private byteCount = 0;
  private decoder = new TextDecoder("utf-8", { fatal: true });
  private hadDecodingReplacement = false;

  add(chunk: Buffer): void {
    this.byteCount += chunk.length;
    if (this.head.length < HEAD_BYTES) {
      this.head = Buffer.concat([this.head, chunk.subarray(0, HEAD_BYTES - this.head.length)]);
    }
    this.tail = Buffer.concat([this.tail, chunk]);
    if (this.tail.length > TAIL_BYTES) this.tail = this.tail.subarray(this.tail.length - TAIL_BYTES);
    try {
      this.decoder.decode(chunk, { stream: true });
    } catch {
      this.hadDecodingReplacement = true;
      this.decoder = new TextDecoder("utf-8", { fatal: true });
    }
  }

  result(): OutputPreview {
    try {
      this.decoder.decode();
    } catch {
      this.hadDecodingReplacement = true;
    }
    return {
      head: this.head.toString("utf8"),
      tail: this.tail.toString("utf8"),
      bytes: this.byteCount,
      encoding: "utf8-replacement",
      hadDecodingReplacement: this.hadDecodingReplacement
    };
  }
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function processGroupIsAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupIsAlive(pid) && Date.now() < deadline) {
    await wait(Math.min(25, Math.max(1, deadline - Date.now())));
  }
  return !processGroupIsAlive(pid);
}

async function terminateProcessTree(
  subprocess: ResultPromise,
  graceMs: number,
  isSettled: () => boolean
): Promise<ProcessCleanupResult> {
  const pid = subprocess.pid;
  const cleanup: ProcessCleanupResult = {
    attempted: true,
    ...(process.platform === "win32" ? { limitation: "Windows process-tree cleanup uses best-effort taskkill and cannot guarantee complete descendant termination." } : {})
  };
  if (!pid) {
    cleanup.error = "Child process PID was unavailable.";
    return cleanup;
  }

  try {
    if (process.platform === "win32") {
      cleanup.gracefulSignal = "taskkill /T";
      const graceful = await execa("taskkill", ["/PID", String(pid), "/T"], { reject: false });
      cleanup.gracefulSucceeded = graceful.exitCode === 0;
    } else {
      cleanup.gracefulSignal = "SIGTERM";
      process.kill(-pid, "SIGTERM");
    }
  } catch (error) {
    const noProcess = error instanceof Error && "code" in error && error.code === "ESRCH";
    cleanup.gracefulSucceeded = noProcess;
    if (!noProcess) {
      cleanup.error = error instanceof Error ? error.message : String(error);
      subprocess.kill("SIGTERM");
    }
  }

  if (process.platform === "win32") {
    await wait(graceMs);
    if (isSettled() && cleanup.gracefulSucceeded) return cleanup;
  } else {
    cleanup.gracefulSucceeded = await waitForProcessGroupExit(pid, graceMs);
    if (cleanup.gracefulSucceeded) return cleanup;
  }

  try {
    if (process.platform === "win32") {
      cleanup.forceSignal = "taskkill /T /F";
      const forced = await execa("taskkill", ["/PID", String(pid), "/T", "/F"], { reject: false });
      cleanup.forceSucceeded = forced.exitCode === 0;
    } else {
      cleanup.forceSignal = "SIGKILL";
      process.kill(-pid, "SIGKILL");
      cleanup.forceSucceeded = await waitForProcessGroupExit(pid, Math.max(100, Math.min(graceMs, 1_000)));
      if (!cleanup.forceSucceeded) cleanup.error = cleanup.error ?? `Process group ${pid} remained alive after SIGKILL.`;
    }
  } catch (error) {
    const noProcess = error instanceof Error && "code" in error && error.code === "ESRCH";
    cleanup.forceSucceeded = noProcess;
    if (!noProcess) {
      cleanup.error = cleanup.error ?? (error instanceof Error ? error.message : String(error));
      subprocess.kill("SIGKILL");
    }
  }
  return cleanup;
}

export interface RunProcessOptions {
  spec: ProcessSpec;
  projectRoot: string;
  stdoutPath: string;
  stderrPath: string;
  input?: string;
  timeoutMs: number;
  terminationGraceMs: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export async function runProcess(options: RunProcessOptions): Promise<ProcessResult> {
  await fs.ensureDir(path.dirname(options.stdoutPath));
  await Promise.all([fs.ensureFile(options.stdoutPath), fs.ensureFile(options.stderrPath)]);
  const stdoutFile = createWriteStream(options.stdoutPath, { flags: "w", mode: 0o600 });
  const stderrFile = createWriteStream(options.stderrPath, { flags: "w", mode: 0o600 });
  const stdoutPreview = new PreviewCollector();
  const stderrPreview = new PreviewCollector();
  const started = new Date();
  const startedMs = Date.now();
  const actual = actualCommand(options.spec);
  const persisted = persistedCommand(options.spec);
  let subprocess: ResultPromise | undefined;
  let settled = false;
  let timedOut = false;
  let interrupted = false;
  let cleanup: ProcessCleanupResult = { attempted: false };
  let terminationPromise: Promise<ProcessCleanupResult> | undefined;

  const requestTermination = (reason: "timeout" | "interrupt"): void => {
    if (!subprocess || terminationPromise) return;
    timedOut = reason === "timeout";
    interrupted = reason === "interrupt";
    terminationPromise = terminateProcessTree(subprocess, options.terminationGraceMs, () => settled);
  };

  let timeout: NodeJS.Timeout | undefined;
  const onAbort = () => requestTermination("interrupt");

  try {
    subprocess = execa(actual.file, actual.args, {
      cwd: options.projectRoot,
      env: options.env,
      reject: false,
      buffer: false,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: process.platform !== "win32",
      stripFinalNewline: false
    });

    subprocess.stdout?.on("data", (chunk: Buffer | string) => stdoutPreview.add(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    subprocess.stderr?.on("data", (chunk: Buffer | string) => stderrPreview.add(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    subprocess.stdout?.pipe(stdoutFile);
    subprocess.stderr?.pipe(stderrFile);
    if (options.input !== undefined) subprocess.stdin?.end(options.input);
    else subprocess.stdin?.end();

    timeout = setTimeout(() => requestTermination("timeout"), options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) requestTermination("interrupt");
    const result = await subprocess;
    settled = true;
    if (terminationPromise) cleanup = await terminationPromise;
    const spawnError = result.failed && result.exitCode === undefined && result.signal === undefined
      ? redactShellCommand(result.shortMessage || result.originalMessage || "Process could not be spawned.")
      : undefined;

    return {
      kind: options.spec.kind,
      executable: persisted.executable,
      args: persisted.args,
      displayCommand: persisted.displayCommand,
      cwd: ".",
      providedEnvironmentKeys: Object.keys(options.env ?? {}).sort(),
      startedAt: started.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
      signal: result.signal ?? null,
      timedOut,
      interrupted,
      spawnError,
      stdoutArtifact: path.relative(options.projectRoot, options.stdoutPath).split(path.sep).join("/"),
      stderrArtifact: path.relative(options.projectRoot, options.stderrPath).split(path.sep).join("/"),
      stdoutPreview: stdoutPreview.result(),
      stderrPreview: stderrPreview.result(),
      cleanup
    };
  } catch (error) {
    settled = true;
    if (terminationPromise) cleanup = await terminationPromise;
    return {
      kind: options.spec.kind,
      executable: persisted.executable,
      args: persisted.args,
      displayCommand: persisted.displayCommand,
      cwd: ".",
      providedEnvironmentKeys: Object.keys(options.env ?? {}).sort(),
      startedAt: started.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      exitCode: null,
      signal: null,
      timedOut,
      interrupted,
      spawnError: redactShellCommand(error instanceof Error ? error.message : String(error)),
      stdoutArtifact: path.relative(options.projectRoot, options.stdoutPath).split(path.sep).join("/"),
      stderrArtifact: path.relative(options.projectRoot, options.stderrPath).split(path.sep).join("/"),
      stdoutPreview: stdoutPreview.result(),
      stderrPreview: stderrPreview.result(),
      cleanup
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
    if (!stdoutFile.writableEnded) stdoutFile.end();
    if (!stderrFile.writableEnded) stderrFile.end();
    await Promise.all([
      finished(stdoutFile).catch(() => undefined),
      finished(stderrFile).catch(() => undefined)
    ]);
  }
}
