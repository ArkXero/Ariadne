import React from "react";
import { renderToString } from "ink";
import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import {
  AriadneTuiView,
  filteredTasks,
  layoutFor,
  packFooterBindings,
  statusLabel,
  visibleWindow,
  windowLabel
} from "../src/tui/components.js";
import { initialTuiState } from "../src/tui/state.js";
import type { AttemptDetail, BatchHistoryEntry, TaskHistoryEntry, TuiSnapshot, TuiState } from "../src/tui/types.js";

function fixture(): { snapshot: TuiSnapshot; detail: AttemptDetail } {
  const attempts: TaskHistoryEntry["attempts"] = [{
    key: "b1:task:attempt:1", manifestPath: ".ariadne/runs/r1/run.json", manifest: ".ariadne/runs/r1/run.json", final: true, source: "batch",
    attempt: 1, runId: "r1", status: "failed", outcome: "verification_failed", score: 100, startedAt: "2026-07-16T00:00:00.000Z",
    completedAt: "2026-07-16T00:00:02.000Z", durationMs: 2_000, retryEligible: false
  }];
  const task: TaskHistoryEntry = {
    key: "b1:task", source: "batch", batchId: "b1", taskId: "task", name: "Compile <script> literally", state: "failed", outcome: "verification_failed",
    startedAt: "2026-07-16T00:00:00.000Z", durationMs: 2_000, score: 100, resultState: "unapplied", attempts, finalAttempt: 1,
    workspaceState: "retained", warnings: []
  };
  const batch = {
    key: "b1",
    record: {
      batchId: "b1", batchStatus: "partially_failed", outcome: "verification_failed", startedAt: "2026-07-16T00:00:00.000Z", durationMs: 2_000,
      summary: { total: 1, succeeded: 0, failed: 1, blocked: 0, skipped: 0, interrupted: 0, incomplete: 0, retried: 0, score: 100, status: "failed", outcome: "verification_failed" },
      tasks: [], warnings: [], lifecycle: [], artifacts: { manifest: ".ariadne/batches/b1/batch.json" }, plan: { isolation: "worktree", retention: "on-failure" }
    },
    report: {
      batchId: "b1", durationMs: 2_000, score: 100, isolation: "worktree", retention: "on-failure", summary: { total: 1, succeeded: 0 },
      tasks: [{ id: "task", name: "Compile <script> literally", status: "failed", outcome: "verification_failed", attempts: 1, score: 100, history: [] }],
      warnings: ["Fixture warning"], graph: { order: ["task"], planId: "plan-1" }
    },
    resultStates: { r1: "unapplied" }
  } as unknown as BatchHistoryEntry;
  const snapshot: TuiSnapshot = {
    loadedAt: "2026-07-16T00:00:03.000Z", configuration: "available", batches: [batch], tasks: [task], workspaces: [], promotions: [],
    warnings: [{ id: "warning:0", code: "missing-artifact", message: "Missing <script> artifact", path: ".ariadne/log.txt" }],
    attention: { unappliedResults: 1, retainedWorktrees: 1, failedWorkflows: 1, warnings: 1 }
  };
  const process = {
    command: "node agent.mjs", status: "passed", exitCode: 0, signal: null, durationMs: 200,
    stdoutPreview: "first line\nsecond line\nthird line", stderrPreview: "", stdoutArtifact: ".ariadne/runs/r1/stdout.log"
  };
  const detail = {
    reference: attempts[0], taskIndex: 0, resultState: "unapplied",
    report: {
      schemaVersion: 5, runId: "r1", status: "failed", outcome: "verification_failed", startedAt: "2026-07-16T00:00:00.000Z",
      completedAt: "2026-07-16T00:00:02.000Z", durationMs: 2_000, warnings: [], failures: [], lifecycle: [], promotions: [],
      tasks: [{
        id: "task", name: "Compile <script> literally", status: "failed", outcome: "verification_failed", durationMs: 2_000,
        agent: process, verification: [], changedFiles: ["src/a.ts"], preexistingFiles: [], changes: [], preexistingEntries: [], diffLineCount: 3,
        policies: [
          ...Array.from({ length: 6 }, (_, index) => ({ ruleId: `pass.${index}`, outcome: "pass", penalty: 0, summary: `Passed check ${index}`, evidence: {} })),
          { ruleId: "verification.nonzero", outcome: "fail", penalty: 25, summary: "Verification exited with code 1", evidence: {} }
        ],
        score: 100, failures: ["[VERIFICATION_NONZERO] Verification command exited with code 1."], lifecycle: []
      }]
    }
  } as unknown as AttemptDetail;
  return { snapshot, detail };
}

function stateFor(screen: TuiState["screen"], snapshot = fixture().snapshot): TuiState {
  const { detail } = fixture();
  return {
    ...initialTuiState(),
    snapshot,
    screen,
    attempts: { [detail.reference.key]: detail },
    logs: {
      [`${detail.reference.key}:0:stdout`]: {
        path: ".ariadne/runs/r1/stdout.log", status: "ready", text: "first line\nsecond line\nthird line", totalBytes: 32, readBytes: 32, truncated: false
      }
    }
  };
}

function render(screen: TuiState["screen"], options: Partial<{ width: number; height: number; color: boolean; unicode: boolean }> = {}, snapshot?: TuiSnapshot): string {
  const width = options.width ?? 120;
  return renderToString(
    <AriadneTuiView state={stateFor(screen, snapshot)} width={width} height={options.height ?? 30} color={options.color ?? false} unicode={options.unicode ?? true} />,
    { columns: width }
  );
}

describe("responsive TUI dashboard", () => {
  it("selects the documented width and height breakpoints", () => {
    expect(layoutFor(120, 30)).toBe("wide");
    expect(layoutFor(120, 19)).toBe("compact");
    expect(layoutFor(80, 24)).toBe("compact");
    expect(layoutFor(50, 20)).toBe("stacked");
    expect(layoutFor(39, 20)).toBe("minimum");
    expect(layoutFor(80, 11)).toBe("minimum");
  });

  it("renders master/detail panes for every wide screen", () => {
    const cases: Array<{ screen: TuiState["screen"]; labels: string[] }> = [
      { screen: { kind: "dashboard", selection: 0 }, labels: ["Workflows", "Selected workflow", "Needs attention"] },
      { screen: { kind: "history", mode: "tasks", filter: "all", selection: 0 }, labels: ["History", "Selected task"] },
      { screen: { kind: "workflow", batchKey: "b1", selection: 0 }, labels: ["Tasks", "Workflow overview", "Selected task", "Warnings"] },
      { screen: { kind: "task", taskKey: "b1:task", selection: 0 }, labels: ["Attempts", "Task overview", "Selected attempt"] },
      { screen: { kind: "attempt", taskKey: "b1:task", attemptIndex: 0, processIndex: 0, stream: "stdout", scroll: 0 }, labels: ["Attempt 1", "Process", "Failures and policies", "Process output"] },
      { screen: { kind: "warnings", selection: 0 }, labels: ["Warnings", "Warning detail"] }
    ];
    for (const item of cases) {
      const output = render(item.screen);
      for (const label of item.labels) expect(output, item.screen.kind).toContain(label);
      if (["workflow", "task"].includes(item.screen.kind)) expect(output, item.screen.kind).toContain("✗ Failed  Verification failed");
    }
  });

  it("renders contextual help in two readable groups", () => {
    const state = stateFor({ kind: "help" });
    state.backStack = [{ kind: "attempt", taskKey: "b1:task", attemptIndex: 0, processIndex: 0, stream: "stdout", scroll: 0 }];
    const output = renderToString(<AriadneTuiView state={state} width={120} height={30} color={false} unicode />, { columns: 120 });
    expect(output).toContain("Navigation");
    expect(output).toContain("Attempt actions");
    expect(output).toContain("Next process");
    expect(output).toContain("Change promotion, cleanup, remote execution");
  });

  it("fills the viewport and leaves the packed footer on the last row", () => {
    for (const [width, height] of [[120, 30], [80, 24], [50, 20], [35, 10]] as const) {
      const output = render({ kind: "dashboard", selection: 0 }, { width, height });
      const lines = output.split("\n");
      expect(lines).toHaveLength(height);
      expect(lines[0]).toMatch(/^Ariadne/);
      if (width >= 40) expect(lines.at(-1)).toContain("refresh");
    }
  });

  it("keeps compact and stacked modes in drill-down form", () => {
    const compact = render({ kind: "history", mode: "tasks", filter: "all", selection: 0 }, { width: 80, height: 24 });
    expect(compact).toContain("History");
    expect(compact).not.toContain("Selected task");
    const stacked = render({ kind: "history", mode: "tasks", filter: "all", selection: 0 }, { width: 50, height: 20 });
    expect(stacked).toContain("task: Compile <script> literally");
    expect(stacked).not.toMatch(/[╭╮╰╯]/);
  });

  it("retains the essential controls below minimum size", () => {
    const output = render({ kind: "dashboard", selection: 0 }, { width: 35, height: 10 });
    expect(output).toContain("Terminal too small");
    expect(output).toContain("r refresh  ? help  q quit");
  });
});

describe("density, semantics, and overflow", () => {
  it("windows long lists around selection and reports the visible range", () => {
    expect(visibleWindow(30, 22, 8)).toEqual({ start: 18, end: 26 });
    expect(windowLabel({ start: 18, end: 26 }, 30)).toBe("19-26 of 30");
    expect(visibleWindow(3, 99, 10)).toEqual({ start: 0, end: 3 });
  });

  it("packs only complete high-priority footer commands", () => {
    const packed = packFooterBindings("attempt", 40);
    const display = packed.map((binding) => `${binding.keys} ${binding.label}`).join("  ");
    expect(stringWidth(display)).toBeLessThanOrEqual(40);
    expect(packed.map((binding) => binding.action)).toEqual(["previous-attempt", "next-attempt"]);
  });

  it("shows failures before a compressed passing-policy summary", () => {
    const output = render({ kind: "attempt", taskKey: "b1:task", attemptIndex: 0, processIndex: 0, stream: "stdout", scroll: 0 });
    expect(output).toContain("[VERIFICATION_NONZERO]");
    expect(output).toContain("6 checks passed");
    expect(output).toContain("1 failed");
    expect(output.indexOf("[VERIFICATION_NONZERO]")).toBeLessThan(output.indexOf("6 checks passed"));
  });

  it("uses rounded Unicode or square ASCII frames, symbols, and separators consistently", () => {
    const unicode = render({ kind: "dashboard", selection: 0 }, { unicode: true });
    expect(unicode).toMatch(/[╭╮╰╯]/);
    expect(unicode).toContain("╮╭");
    expect(unicode).not.toMatch(/[┌┐└┘]/);
    expect(unicode).toContain(" · ");
    expect(unicode).toContain("✗");
    const ascii = render({ kind: "dashboard", selection: 0 }, { unicode: false });
    expect(ascii).toContain("+");
    expect(ascii).toContain(" | ");
    expect(ascii).toContain("[FAIL]");
    expect(ascii).not.toMatch(/[·✓✗●◷—╭╮╰╯┌┐└┘]/);
  });

  it("keeps semantic status cues meaningful without color", () => {
    const color = render({ kind: "dashboard", selection: 0 }, { color: true });
    expect(color).toContain("✗ Failed");
    expect(color).toContain("> R b1");
    const monochrome = render({ kind: "dashboard", selection: 0 }, { color: false });
    expect(monochrome).not.toMatch(/\u001B\[[0-9;]*m/);
    expect(monochrome).toContain("Failed");
  });

  it("keeps status meaning and filters independent of presentation", () => {
    expect(statusLabel("passed")).toBe("Passed");
    expect(statusLabel("verification_failed")).toBe("Failed");
    expect(statusLabel("running")).toBe("Running");
    expect(statusLabel("warning")).toBe("Warning");
    expect(statusLabel("blocked")).toBe("Blocked");
    expect(statusLabel("not-applicable")).toBe("Not applicable");
    const { snapshot } = fixture();
    expect(filteredTasks(snapshot, "unapplied").map((task) => task.key)).toEqual(["b1:task"]);
    expect(filteredTasks(snapshot, "workspace").map((task) => task.key)).toEqual(["b1:task"]);
    expect(filteredTasks(snapshot, "failed").map((task) => task.key)).toEqual(["b1:task"]);
  });

  it("preserves literal markup and handles empty invalid history", () => {
    expect(render({ kind: "warnings", selection: 0 })).toContain("Missing <script> artifact");
    const { snapshot } = fixture();
    const empty: TuiSnapshot = { ...snapshot, configuration: "invalid", batches: [], tasks: [], warnings: [] };
    const output = render({ kind: "history", mode: "batches", filter: "all", selection: 0 }, {}, empty);
    expect(output).toContain("Config invalid");
    expect(output).toContain("No records match this filter.");
    expect(output).toContain("No workflow selected.");
  });
});
