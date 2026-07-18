import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { tuiCommand, type TuiCommandOptions } from "../src/commands/tui.js";
import { createTerminalSession, ENTER_ALTERNATE_SCREEN, LEAVE_ALTERNATE_SCREEN, supportsTuiColor, supportsUnicodeTerminal } from "../src/tui/terminal.js";
import type { WorkflowExecutionHandle } from "../src/core/workflow-application.js";
import type { BatchRecord } from "../src/types/index.js";
import type { TuiDataService, TuiSnapshot } from "../src/tui/types.js";

const snapshot: TuiSnapshot = {
  loadedAt: "2026-07-16T00:00:00.000Z", configuration: "missing", batches: [], tasks: [], workspaces: [], promotions: [],
  warnings: [], attention: { unappliedResults: 0, retainedWorktrees: 0, failedWorkflows: 0, warnings: 0 }
};

const service: TuiDataService = {
  async loadSnapshot() { return snapshot; },
  async loadAttempt() { throw new Error("not used"); },
  async loadLogPreview(relativePath) { return { path: relativePath, status: "missing", text: "", totalBytes: 0, readBytes: 0, truncated: false }; }
};

class TtyInput extends PassThrough {
  isTTY = true;
  isRaw = false;
  setRawMode(value: boolean) { this.isRaw = value; return this; }
  ref() { return this; }
  unref() { return this; }
}

class TtyOutput extends PassThrough {
  isTTY = true;
  columns = 80;
  rows = 24;
  getColorDepth() { return 8; }
}

async function runAndStop(kind: "q" | "SIGINT" | "SIGTERM"): Promise<{ output: string; raw: boolean }> {
  const stdin = new TtyInput();
  const stdout = new TtyOutput();
  const stderr = new TtyOutput();
  const signals = new EventEmitter();
  let output = "";
  stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  const running = tuiCommand({ cwd: process.cwd(), stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, stderr: stderr as unknown as NodeJS.WriteStream, service, signalTarget: signals as unknown as Pick<NodeJS.Process, "once" | "off">, environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8", NO_COLOR: "1" }, setExitCode: () => undefined });
  await new Promise((resolve) => setTimeout(resolve, 20));
  if (kind === "q") stdin.write("q");
  else signals.emit(kind);
  await Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error("TUI teardown timed out")), 2_000))]);
  return { output, raw: stdin.isRaw };
}

function attachedService() {
  let settle!: (value: BatchRecord & { outputPath: string }) => void;
  const completion = new Promise<BatchRecord & { outputPath: string }>((resolve) => { settle = resolve; });
  let cancellations = 0;
  const handle: WorkflowExecutionHandle = {
    batchId: "attached",
    startedAt: "2026-07-17T00:00:00.000Z",
    completion,
    subscribe: () => () => undefined,
    latestSnapshot: () => ({ batchId: "attached", state: "running", lastSequence: 0 }),
    requestCancellation: () => { cancellations += 1; return completion; }
  };
  const value = {
    ...service,
    registry: {
      current: () => handle,
      waitForIdle: () => completion.then(() => undefined, () => undefined)
    },
    cancellationTimeoutMs: async () => 200
  } as unknown as TuiDataService;
  return {
    service: value,
    settle: () => settle({ batchId: "attached", batchStatus: "interrupted", outcome: "interrupted", artifacts: { manifest: "batch.json" } } as BatchRecord & { outputPath: string }),
    cancellations: () => cancellations
  };
}

describe("terminal adapter", () => {
  it("enters and restores alternate screen exactly once", () => {
    let output = "";
    const session = createTerminalSession({ write(value) { output += String(value); return true; } } as Pick<NodeJS.WriteStream, "write">);
    session.enter();
    session.enter();
    session.restore();
    session.restore();
    expect(output).toBe(`${ENTER_ALTERNATE_SCREEN}${LEAVE_ALTERNATE_SCREEN}`);
    expect(ENTER_ALTERNATE_SCREEN).toContain("\u001B[2J");
    expect(ENTER_ALTERNATE_SCREEN).toContain("\u001B[H");
    expect(ENTER_ALTERNATE_SCREEN.indexOf("\u001B[2J")).toBeLessThan(ENTER_ALTERNATE_SCREEN.indexOf("\u001B[H"));
    expect(session.active).toBe(false);
  });

  it("falls back to ASCII for dumb or non-UTF-8 terminals", () => {
    expect(supportsUnicodeTerminal({ TERM: "dumb", LANG: "en_US.UTF-8" })).toBe(false);
    expect(supportsUnicodeTerminal({ TERM: "xterm", LANG: "C" })).toBe(false);
    expect(supportsUnicodeTerminal({ TERM: "xterm", LANG: "en_US.UTF-8" })).toBe(true);
  });

  it("honors NO_COLOR and explicit --no-color", () => {
    const output = new TtyOutput() as unknown as NodeJS.WriteStream;
    expect(supportsTuiColor(output, true, { TERM: "xterm", NO_COLOR: "1" })).toBe(false);
    expect(supportsTuiColor(output, false, { TERM: "xterm" })).toBe(false);
    expect(supportsTuiColor(output, true, { TERM: "xterm-256color" })).toBe(true);
  });

  it("rejects non-TTY streams before writing ANSI", async () => {
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    let output = "";
    stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    await expect(tuiCommand({ cwd: process.cwd(), stdin, stdout, service })).rejects.toThrow("requires interactive stdin/stdout");
    expect(output).toBe("");
  });

  it("restores raw mode and alternate screen on normal quit", async () => {
    const result = await runAndStop("q");
    expect(result.raw).toBe(false);
    expect(result.output).toContain(ENTER_ALTERNATE_SCREEN);
    expect(result.output).toContain(LEAVE_ALTERNATE_SCREEN);
  });

  it("restores terminal state on SIGINT", async () => {
    const result = await runAndStop("SIGINT");
    expect(result.raw).toBe(false);
    expect(result.output).toContain(LEAVE_ALTERNATE_SCREEN);
  });

  it("restores terminal state on SIGTERM", async () => {
    const result = await runAndStop("SIGTERM");
    expect(result.raw).toBe(false);
    expect(result.output).toContain(LEAVE_ALTERNATE_SCREEN);
  });

  it("restores the terminal on confirmed detach but keeps the command occupied until completion", async () => {
    const stdin = new TtyInput();
    const stdout = new TtyOutput();
    const stderr = new TtyOutput();
    const signals = new EventEmitter();
    const attached = attachedService();
    let output = "";
    let finished = false;
    stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    const running = tuiCommand({ cwd: process.cwd(), stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, stderr: stderr as unknown as NodeJS.WriteStream, service: attached.service, signalTarget: signals as unknown as Pick<NodeJS.Process, "once" | "off">, setExitCode: () => undefined }).then(() => { finished = true; });
    await new Promise((resolve) => setTimeout(resolve, 150));
    stdin.write("q");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(output).toContain("Detach TUI?");
    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stdin.isRaw).toBe(false);
    expect(output).toContain(LEAVE_ALTERNATE_SCREEN);
    expect(finished).toBe(false);
    attached.settle();
    await running;
    expect(finished).toBe(true);
  });

  it("requests active cancellation on SIGINT and waits for finalization before restoring", async () => {
    const stdin = new TtyInput();
    const stdout = new TtyOutput();
    const stderr = new TtyOutput();
    const signals = new EventEmitter();
    const attached = attachedService();
    let exitCode: number | undefined;
    const running = tuiCommand({ cwd: process.cwd(), stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, stderr: stderr as unknown as NodeJS.WriteStream, service: attached.service, signalTarget: signals as unknown as Pick<NodeJS.Process, "once" | "off">, setExitCode: (code) => { exitCode = code; } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    signals.emit("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(attached.cancellations()).toBe(1);
    expect(stdin.isRaw).toBe(true);
    attached.settle();
    await running;
    expect(stdin.isRaw).toBe(false);
    expect(exitCode).toBe(130);
  });

  it("restores the terminal after a render failure and lets the attached workflow finish safely", async () => {
    const stdin = new TtyInput();
    const stdout = new TtyOutput();
    const stderr = new TtyOutput();
    const attached = attachedService();
    const failure = new Error("render failed");
    let output = "";
    let finished = false;
    stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    const renderTui = (() => {
      stdin.setRawMode(true);
      return {
        waitUntilExit: async () => { throw failure; },
        cleanup: () => { stdin.setRawMode(false); },
        unmount: () => undefined
      };
    }) as unknown as NonNullable<TuiCommandOptions["renderTui"]>;
    const running = tuiCommand({
      cwd: process.cwd(), stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream, service: attached.service, renderTui
    }).finally(() => { finished = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(stdin.isRaw).toBe(false);
    expect(output).toContain(LEAVE_ALTERNATE_SCREEN);
    expect(finished).toBe(false);
    attached.settle();
    await expect(running).rejects.toThrow("render failed");
  });
});
