import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { AriadneTui } from "../src/tui/app.js";
import { WorkflowRuntimeChannel } from "../src/core/workflow-runtime.js";
import type { WorkflowExecutionHandle, WorkflowInspection, WorkflowPlanPreview } from "../src/core/workflow-application.js";
import type { BatchRecord, WorkflowPlan } from "../src/types/index.js";
import type { TuiDataService, TuiSnapshot } from "../src/tui/types.js";

const snapshot: TuiSnapshot = {
  loadedAt: "2026-07-17T00:00:00.000Z",
  configuration: "available",
  batches: [], tasks: [], workspaces: [], promotions: [], results: [], workspaceDetails: [], warnings: [],
  attention: { unappliedResults: 0, conflictedResults: 0, applicationFailures: 0, ineligibleResults: 0, missingOrCorruptResults: 0, retainedWorktrees: 0, staleWorktrees: 0, cleanupFailures: 0, failedWorkflows: 0, warnings: 0 }
};

const inspection: WorkflowInspection = {
  projectRoot: "/tmp/project",
  configPath: "ariadne.yml",
  tasks: [
    { id: "build", name: "Build", tags: [], dependencies: ["foundation"], workspaceMode: "mutable", retry: { attempts: 2, delayMs: 50, backoff: "fixed" } },
    { id: "foundation", name: "Foundation", description: "Inspect the codebase.", group: "analysis", tags: ["safe"], dependencies: [], workspaceMode: "read-only", retry: { attempts: 1, delayMs: 0, backoff: "fixed" } }
  ],
  defaults: { concurrency: 1, failureMode: "continue", isolation: "shared", allowDirtyBase: false },
  sourceHead: "abc123",
  sourceDirty: false,
  dirtyPaths: [],
  warnings: []
};

function preview(taskIds: string[], concurrency = 1): WorkflowPlanPreview {
  const selected = new Set(taskIds);
  const includeBuild = selected.has("build");
  const ids = includeBuild ? ["foundation", "build"] : ["foundation"];
  const plan: WorkflowPlan = {
    schemaVersion: 2, planId: `plan-${concurrency}`, createdAt: "2026-07-17T00:00:00.000Z", configFingerprint: "fingerprint",
    selectedRoots: [...taskIds], includedTasks: ids, edges: includeBuild ? [{ from: "foundation", to: "build" }] : [],
    levels: includeBuild ? [["foundation"], ["build"]] : [["foundation"]], concurrencyGroups: ids.map((id) => [id]), order: ids,
    tasks: ids.map((id, index) => ({
      id, name: id === "build" ? "Build" : "Foundation", file: `${id}.yml`, dependencies: id === "build" ? ["foundation"] : [],
      level: index, order: index, selected: selected.has(id), workspaceMode: id === "build" ? "mutable" : "read-only",
      retry: id === "build" ? { attempts: 2, delayMs: 50, backoff: "fixed" } : { attempts: 1, delayMs: 0, backoff: "fixed" }, verification: []
    })),
    concurrency, failureMode: "continue", isolation: "shared", retention: "on-failure", dirtyBaseAcknowledged: false
  };
  return { ...inspection, plan, blockers: [] };
}

async function waitForFrame(lastFrame: () => string | undefined, text: string): Promise<string> {
  for (let index = 0; index < 200; index += 1) {
    const frame = lastFrame() ?? "";
    if (frame.includes(text)) return frame;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Frame never contained ${text}:\n${lastFrame() ?? ""}`);
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("operational TUI keyboard workflow", () => {
  it("selects, replans options, confirms, monitors redacted output, and confirms cancellation", async () => {
    const channel = new WorkflowRuntimeChannel("batch-live");
    let settle!: (batch: BatchRecord & { outputPath: string }) => void;
    const completion = new Promise<BatchRecord & { outputPath: string }>((resolve) => { settle = resolve; });
    const requestCancellation = vi.fn(() => completion);
    const handle: WorkflowExecutionHandle = {
      batchId: "batch-live",
      startedAt: "2026-07-17T00:00:00.000Z",
      completion,
      subscribe: (listener) => channel.subscribe(listener),
      latestSnapshot: () => channel.latestSnapshot(),
      requestCancellation
    };
    const createPreview = vi.fn((taskIds: string[], overrides: { concurrency?: number }) => Promise.resolve(preview(taskIds, overrides.concurrency)));
    const service: TuiDataService = {
      async loadSnapshot() { return snapshot; },
      async loadAttempt() { throw new Error("not used"); },
      async loadLogPreview(relativePath) { return { path: relativePath, status: "missing", text: "", totalBytes: 0, readBytes: 0, truncated: false }; },
      async inspectWorkflowOptions() { return inspection; },
      createWorkflowPlanPreview: createPreview,
      async startWorkflowExecution() { return handle; }
    };
    const view = render(<AriadneTui service={service} color={false} unicode dimensions={{ width: 100, height: 28 }} />);
    await waitForFrame(view.lastFrame, "No workflow history");

    view.stdin.write("p");
    expect(await waitForFrame(view.lastFrame, "Select tasks")).toContain("> [ ] build");
    await pause();
    view.stdin.write(" ");
    expect(await waitForFrame(view.lastFrame, "[x] build")).toContain("> [x] build");
    await pause();
    view.stdin.write("\r");
    expect(await waitForFrame(view.lastFrame, "Workflow plan")).toContain("ROOT build");
    expect(view.lastFrame()).toContain("DEP foundation");

    await pause();
    view.stdin.write("e");
    await waitForFrame(view.lastFrame, "Execution options");
    await pause();
    view.stdin.write("l");
    expect(await waitForFrame(view.lastFrame, "Concurrency       2")).toContain("Concurrency");
    await pause();
    view.stdin.write("\r");
    await waitForFrame(view.lastFrame, "Workflow plan");
    expect(createPreview).toHaveBeenLastCalledWith(["build"], expect.objectContaining({ concurrency: 2 }));
    await pause();
    view.stdin.write("\r");
    await waitForFrame(view.lastFrame, "Launch workflow?");
    await pause();
    view.stdin.write("\r");
    await waitForFrame(view.lastFrame, "batch-live");

    channel.emit({ type: "process.started", taskId: "foundation", attempt: 1, runId: "run-1", phase: "agent", commandIndex: 0, displayCommand: "agent" });
    channel.emit({ type: "process.output", taskId: "foundation", attempt: 1, runId: "run-1", phase: "agent", commandIndex: 0, stream: "stdout", chunk: "hello from agent\n" });
    expect(await waitForFrame(view.lastFrame, "hello from agent")).toContain("Live output");

    await pause();
    view.stdin.write("c");
    await waitForFrame(view.lastFrame, "Cancel workflow?");
    await pause();
    view.stdin.write("\u001b");
    await waitForFrame(view.lastFrame, "hello from agent");
    await pause();
    view.stdin.write("c");
    await waitForFrame(view.lastFrame, "Cancel workflow?");
    await pause();
    view.stdin.write("\r");
    await waitForFrame(view.lastFrame, "Cancelling workflow");
    expect(requestCancellation).toHaveBeenCalledTimes(1);

    view.unmount();
    settle({ batchId: "batch-live", batchStatus: "interrupted", outcome: "interrupted", artifacts: { manifest: "batch.json" } } as BatchRecord & { outputPath: string });
  });
});
