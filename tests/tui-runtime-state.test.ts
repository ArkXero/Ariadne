import { describe, expect, it } from "vitest";
import {
  MAX_LIVE_OUTPUT_BYTES,
  MAX_LIVE_OUTPUT_LINES,
  appendLiveOutput,
  createRuntimeView,
  liveOutputText,
  reduceRuntimeEvent,
  type LiveOutputBuffer
} from "../src/tui/runtime-state.js";
import type { WorkflowPlan } from "../src/types/index.js";

const plan: WorkflowPlan = {
  schemaVersion: 2,
  planId: "plan",
  createdAt: "2026-07-17T00:00:00.000Z",
  configFingerprint: "fingerprint",
  selectedRoots: ["task"],
  includedTasks: ["task"],
  edges: [],
  levels: [["task"]],
  concurrencyGroups: [["task"]],
  order: ["task"],
  tasks: [{ id: "task", name: "Task", file: "task.yml", dependencies: [], level: 0, order: 0, selected: true, workspaceMode: "mutable", retry: { attempts: 2, delayMs: 10, backoff: "fixed" }, verification: [] }],
  concurrency: 1,
  failureMode: "continue",
  isolation: "shared",
  retention: "on-failure",
  dirtyBaseAcknowledged: false
};

function buffer(): LiveOutputBuffer {
  return { lines: [], partial: "", bytes: 0, truncated: false, lastStreamSequence: 0 };
}

function base(sequence: number) {
  return { batchId: "batch", timestamp: "2026-07-17T00:00:00.000Z", sequence };
}

describe("TUI runtime reducer and output assembler", () => {
  it("assembles partial lines, sanitizes controls, ignores duplicate stream chunks, and flags gaps", () => {
    let value = appendLiveOutput(buffer(), "hello\u001b[31m", 1);
    value = appendLiveOutput(value, " coral\u001b[0m\nnext", 2);
    const beforeDuplicate = value;
    const duplicate = appendLiveOutput(value, "duplicate", 2);
    value = appendLiveOutput(duplicate, "\nlast", 4);

    expect(duplicate).toBe(beforeDuplicate);
    expect(liveOutputText(value)).toContain("[earlier output truncated]");
    expect(liveOutputText(value)).toContain("hello coral");
    expect(liveOutputText(value)).not.toContain("\u001b");
    expect(liveOutputText(value)).not.toContain("duplicate");
  });

  it("caps live output by both lines and bytes while retaining recent output", () => {
    let value = buffer();
    for (let index = 0; index < MAX_LIVE_OUTPUT_LINES + 100; index += 1) value = appendLiveOutput(value, `${index}:${"x".repeat(600)}\n`, index + 1);
    expect(value.lines.length).toBeLessThanOrEqual(MAX_LIVE_OUTPUT_LINES);
    expect(value.bytes).toBeLessThanOrEqual(MAX_LIVE_OUTPUT_BYTES);
    expect(value.truncated).toBe(true);
    expect(liveOutputText(value)).toContain(String(MAX_LIVE_OUTPUT_LINES + 99));
  });

  it("keeps retry-attempt output in separate run buffers", () => {
    let view = createRuntimeView("batch", plan, plan.createdAt);
    view = reduceRuntimeEvent(view, {
      ...base(1), type: "process.output", taskId: "task", attempt: 1, runId: "run-1", phase: "agent", commandIndex: 0,
      stream: "stdout", streamSequence: 1, chunk: "first attempt\n"
    });
    view = reduceRuntimeEvent(view, {
      ...base(2), type: "process.output", taskId: "task", attempt: 2, runId: "run-2", phase: "agent", commandIndex: 0,
      stream: "stdout", streamSequence: 1, chunk: "second attempt\n"
    });

    expect(view.tasks[0]?.processes).toHaveLength(2);
    expect(view.tasks[0]?.processes.map((process) => [process.attempt, liveOutputText(process.stdout)])).toEqual([
      [1, "first attempt"],
      [2, "second attempt"]
    ]);
  });

  it("ignores duplicates, warns on runtime sequence gaps and malformed events, and tracks retries and blockers", () => {
    let view = createRuntimeView("batch", plan, plan.createdAt);
    view = reduceRuntimeEvent(view, { ...base(1), type: "task.started", taskId: "task", attempt: 1 });
    const duplicate = reduceRuntimeEvent(view, { ...base(1), type: "task.completed", taskId: "task", attempt: 1, state: "failed" });
    expect(duplicate).toBe(view);
    view = reduceRuntimeEvent(view, { ...base(3), type: "task.retry_scheduled", taskId: "task", currentAttempt: 1, nextAttempt: 2, retryAt: "2026-07-17T00:00:01.000Z", reason: "agent failed" });
    expect(view.tasks[0]).toMatchObject({ state: "retry_wait", attempt: 1, retryReason: "agent failed" });
    expect(view.warnings.join(" ")).toContain("sequence gap");
    view = reduceRuntimeEvent(view, { batchId: "batch", timestamp: "bad", sequence: Number.NaN, type: "process.output" });
    expect(view.warnings).toContain("Ignored a malformed runtime event.");
    view = reduceRuntimeEvent(view, { ...base(4), type: "task.blocked", taskId: "task", blockedBy: ["dependency"], reason: "dependency failed" });
    expect(view.tasks[0]).toMatchObject({ state: "blocked", attempt: 0, blockedBy: ["dependency"] });
  });
});
