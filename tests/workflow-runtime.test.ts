import { describe, expect, it } from "vitest";
import { WorkflowRuntimeChannel, type WorkflowRuntimeEvent } from "../src/core/workflow-runtime.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function output(channel: WorkflowRuntimeChannel, chunk: string) {
  channel.emit({
    type: "process.output",
    taskId: "task",
    attempt: 1,
    runId: "run",
    phase: "agent",
    commandIndex: 0,
    stream: "stdout",
    chunk
  });
}

describe("workflow runtime channel", () => {
  it("assigns ordered runtime and per-stream sequences and replays bounded early history", async () => {
    const channel = new WorkflowRuntimeChannel("batch");
    channel.emit({ type: "batch.started", startedAt: "2026-07-17T00:00:00.000Z", planId: "plan" });
    channel.emit({ type: "process.started", taskId: "task", attempt: 1, runId: "run", phase: "agent", commandIndex: 0, displayCommand: "agent" });
    output(channel, "one\n");
    output(channel, "two\n");
    channel.emit({ type: "process.completed", taskId: "task", attempt: 1, runId: "run", phase: "agent", commandIndex: 0, status: "passed", exitCode: 0, timedOut: false });
    channel.emit({ type: "batch.completed", status: "succeeded", outcome: "passed", manifest: ".ariadne/batches/batch/batch.json" });

    const received: WorkflowRuntimeEvent[] = [];
    channel.subscribe((event) => { received.push(event); });
    await tick();

    expect(received.map((event) => event.sequence)).toEqual([...received.map((event) => event.sequence)].sort((a, b) => a - b));
    expect(received.filter((event) => event.type === "process.output").map((event) => event.type === "process.output" ? event.streamSequence : 0)).toEqual([1, 2]);
    expect(received[0]).toMatchObject({ batchId: "batch", type: "batch.started", sequence: 1 });
    expect(received.at(-1)).toMatchObject({ type: "batch.completed" });
    expect(channel.latestSnapshot()).toMatchObject({ state: "completed", lastSequence: 6 });
    expect(Object.isFrozen(received[0])).toBe(true);
  });

  it("does not block emitters, drops old output for a slow subscriber, and preserves terminal events", async () => {
    const channel = new WorkflowRuntimeChannel("batch");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const received: WorkflowRuntimeEvent[] = [];
    let first = true;
    channel.subscribe(async (event) => {
      received.push(event);
      if (first) {
        first = false;
        await gate;
      }
    });
    channel.emit({ type: "batch.started", startedAt: "2026-07-17T00:00:00.000Z", planId: "plan" });
    await tick();
    for (let index = 0; index < 600; index += 1) output(channel, `${index}:${"x".repeat(4096)}\n`);
    channel.emit({ type: "batch.cancellation_requested" });
    channel.emit({ type: "batch.cancellation_progress", stage: "batch-finalizing" });
    channel.emit({ type: "batch.completed", status: "interrupted", outcome: "interrupted", manifest: "batch.json" });
    await tick();
    release();
    for (let index = 0; index < 20 && !received.some((event) => event.type === "batch.completed"); index += 1) await tick();

    expect(received.filter((event) => event.type === "process.output").length).toBeLessThan(600);
    expect(received.some((event) => event.type === "runtime.warning" && event.category === "subscriber-overflow")).toBe(true);
    expect(received.some((event) => event.type === "batch.cancellation_requested")).toBe(true);
    expect(received.at(-1)).toMatchObject({ type: "batch.completed" });
  });

  it("disconnects a failing subscriber without affecting other subscribers", async () => {
    const channel = new WorkflowRuntimeChannel("batch");
    let failures = 0;
    const received: WorkflowRuntimeEvent[] = [];
    channel.subscribe(() => { failures += 1; throw new Error("subscriber failed"); });
    channel.subscribe((event) => { received.push(event); });
    channel.emit({ type: "task.ready", taskId: "task" });
    await tick();
    channel.emit({ type: "task.started", taskId: "task", attempt: 1 });
    await tick();

    expect(failures).toBe(1);
    expect(received.at(-1)).toMatchObject({ type: "task.started" });
  });
});
