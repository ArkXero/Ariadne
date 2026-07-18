import { describe, expect, it } from "vitest";
import { bindingsFor, resolveKey } from "../src/tui/keymap.js";
import { initialTuiState, tuiReducer } from "../src/tui/state.js";
import type { Key } from "ink";
import type { TuiSnapshot } from "../src/tui/types.js";

function key(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false,
    home: false, end: false, return: false, escape: false, ctrl: false, shift: false, tab: false,
    backspace: false, delete: false, meta: false, super: false, hyper: false, capsLock: false, numLock: false,
    ...overrides
  };
}

const snapshot: TuiSnapshot = {
  loadedAt: "2026-07-16T00:00:00.000Z", configuration: "available", batches: [], tasks: [], workspaces: [], promotions: [], results: [], workspaceDetails: [], warnings: [],
  attention: { unappliedResults: 0, conflictedResults: 0, applicationFailures: 0, ineligibleResults: 0, missingOrCorruptResults: 0, retainedWorktrees: 0, staleWorktrees: 0, cleanupFailures: 0, failedWorkflows: 0, warnings: 0 }
};

describe("centralized TUI keymap", () => {
  it("resolves vim and arrow navigation equivalently", () => {
    expect(resolveKey("j", key(), "dashboard")).toBe("down");
    expect(resolveKey("", key({ downArrow: true }), "dashboard")).toBe("down");
  });

  it("resolves contextual history controls", () => {
    expect(resolveKey("", key({ tab: true }), "history")).toBe("toggle-history");
    expect(resolveKey("f", key(), "history")).toBe("cycle-filter");
    expect(resolveKey("f", key(), "dashboard")).toBeUndefined();
  });

  it("resolves attempt process and stream controls", () => {
    expect(resolveKey("]", key(), "attempt")).toBe("next-attempt");
    expect(resolveKey("o", key(), "attempt")).toBe("stdout");
    expect(resolveKey("e", key(), "attempt")).toBe("stderr");
    expect(resolveKey("", key({ pageDown: true }), "attempt")).toBe("page-down");
  });

  it("generates contextual help from the same keymap", () => {
    const actions = bindingsFor("attempt").map((binding) => binding.action);
    expect(actions).toContain("quit");
    expect(actions).toContain("next-process");
    expect(actions).not.toContain("cycle-filter");
  });

  it("resolves the implemented planning, live, cancellation, resume, and rerun controls", () => {
    expect(resolveKey("p", key(), "dashboard")).toBe("plan-workflow");
    expect(resolveKey(" ", key(), "planner")).toBe("toggle-task");
    expect(resolveKey("l", key(), "options")).toBe("option-right");
    expect(resolveKey("", key({ tab: true }), "live")).toBe("next-process");
    expect(resolveKey("c", key(), "live")).toBe("cancel-workflow");
    expect(resolveKey("R", key(), "workflow")).toBe("resume-workflow");
    expect(resolveKey("B", key(), "workflow")).toBe("rerun-branch");
    expect(bindingsFor("planner").map((binding) => binding.action)).toEqual(expect.arrayContaining(["toggle-task", "select-all", "clear-selection"]));
  });

  it("resolves centralized result review and workspace controls", () => {
    expect(resolveKey("", key({ tab: true }), "dashboard")).toBe("toggle-dashboard-focus");
    expect(resolveKey("f", key(), "results")).toBe("cycle-result-filter");
    expect(resolveKey("a", key(), "result")).toBe("preview-apply");
    expect(resolveKey("x", key(), "result")).toBe("preview-discard");
    expect(resolveKey("n", key(), "diff")).toBe("next-file");
    expect(resolveKey("", key({ pageDown: true }), "diff")).toBe("page-down");
    expect(resolveKey("d", key(), "workspaces")).toBe("cleanup-dry-run");
    expect(resolveKey(" ", key(), "apply-confirm")).toBe("acknowledge-risk");
    expect(resolveKey("[", key(), "compare")).toBe("previous-attempt");
    expect(bindingsFor("result").map((binding) => binding.action)).toEqual(expect.arrayContaining(["preview-apply", "preview-discard", "compare-attempts", "inspect-workspace", "export-patch"]));
  });
});

describe("TUI reducer", () => {
  it("maintains an explicit back stack", () => {
    let state = initialTuiState();
    state = tuiReducer(state, { type: "navigate", screen: { kind: "history", mode: "batches", filter: "all", selection: 0 } });
    state = tuiReducer(state, { type: "navigate", screen: { kind: "workflow", batchKey: "b1", selection: 0 } });
    expect(state.backStack).toHaveLength(2);
    state = tuiReducer(state, { type: "back" });
    expect(state.screen.kind).toBe("history");
  });

  it("cycles history mode and deterministic filters", () => {
    let state = tuiReducer(initialTuiState(), { type: "navigate", screen: { kind: "history", mode: "batches", filter: "all", selection: 4 } });
    state = tuiReducer(state, { type: "history-mode" });
    expect(state.screen).toMatchObject({ kind: "history", mode: "tasks", filter: "all", selection: 0 });
    state = tuiReducer(state, { type: "history-filter" });
    expect(state.screen).toMatchObject({ filter: "failed" });
  });

  it("ignores stale snapshot responses", () => {
    let state = initialTuiState();
    state = tuiReducer(state, { type: "snapshot-start", generation: 2 });
    state = tuiReducer(state, { type: "snapshot-success", generation: 1, snapshot });
    expect(state.snapshot).toBeUndefined();
    state = tuiReducer(state, { type: "snapshot-success", generation: 2, snapshot });
    expect(state.snapshot).toBe(snapshot);
  });

  it("ignores duplicate refresh starts and preserves navigation", () => {
    let state = tuiReducer(initialTuiState(), { type: "snapshot-start", generation: 3 });
    state = tuiReducer(state, { type: "navigate", screen: { kind: "warnings", selection: 2 } });
    state = tuiReducer(state, { type: "snapshot-start", generation: 3 });
    expect(state.snapshotRequest).toMatchObject({ generation: 3, loading: true });
    expect(state.screen).toMatchObject({ kind: "warnings", selection: 2 });
  });

  it("does not let stale attempt details replace the latest request", () => {
    let state = initialTuiState();
    state = tuiReducer(state, { type: "attempt-start", key: "run", generation: 4 });
    state = tuiReducer(state, { type: "attempt-start", key: "run", generation: 5 });
    state = tuiReducer(state, { type: "attempt-error", key: "run", generation: 4, error: "stale" });
    expect(state.attemptRequests.run).toMatchObject({ generation: 5, loading: true });
  });

  it("clamps scroll offsets at zero", () => {
    let state = tuiReducer(initialTuiState(), { type: "navigate", screen: { kind: "attempt", taskKey: "task", attemptIndex: 0, processIndex: 0, stream: "stdout", scroll: 2 } });
    state = tuiReducer(state, { type: "scroll", value: -20 });
    expect(state.screen).toMatchObject({ kind: "attempt", scroll: 0 });
  });
});
