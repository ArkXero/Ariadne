import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { AriadneTui } from "../src/tui/app.js";
import type { ApplyEligibility, ApplyPreview, ResultSummary, ReviewResult } from "../src/core/change-application.js";
import type { WorkspaceCleanupPreview, WorkspaceDetail } from "../src/core/workspace-application.js";
import type { PromotionRecord } from "../src/types/index.js";
import type { TuiDataService, TuiSnapshot } from "../src/tui/types.js";

const now = "2026-07-18T00:00:00.000Z";

const result: ReviewResult = {
  key: "run-final", runId: "run-final", manifestPath: ".ariadne/runs/run-final/run.json",
  taskId: "review", taskName: "Review task", batchId: "batch-1", attempt: 2, final: true,
  executionStatus: "completed", outcome: "passed", verificationStatus: "passed", policyStatus: "passed",
  score: 100, changedFiles: 1, additions: 2, deletions: 1, binaryFiles: 0,
  resultState: "unapplied", workspaceState: "retained", completedAt: now
};

const summary: ResultSummary = {
  result, sourceRevision: "source", preparedRevision: "prepared", resultRevision: "result", isolation: "worktree", workspaceId: "ws-review",
  omittedSensitive: [], promotions: [], failures: [], policyFailures: [],
  changes: [{ changeId: "change-1", path: "src/review.ts", changeType: "modified", additions: 2, deletions: 1, binary: false, kind: "file", diff: { status: "text", artifact: ".ariadne/runs/run-final/change.diff", bytes: 80, lines: 8, hunks: 1, sha256: "a".repeat(64) } }]
};

const workspace: WorkspaceDetail = {
  workspaceId: "ws-review", runId: "run-final", batchId: "batch-1", taskId: "review", attempt: 2,
  path: ".ariadne/worktrees/ws-review/checkout", state: "retained", createdAt: now, updatedAt: now, ageMs: 100,
  sourceRevision: "source", preparedRevision: "prepared", retention: "always", sizeBytes: 1024, sizeTruncated: false,
  physicalState: "present", cleanupEligible: true, cleanupBlockers: []
};

function snapshot(): TuiSnapshot {
  return {
    loadedAt: now, configuration: "available", batches: [], tasks: [], workspaces: [], promotions: [],
    results: [result], workspaceDetails: [workspace], warnings: [],
    attention: {
      unappliedResults: 1, conflictedResults: 0, applicationFailures: 0, ineligibleResults: 0,
      missingOrCorruptResults: 0, retainedWorktrees: 1, staleWorktrees: 0, cleanupFailures: 0,
      failedWorkflows: 0, warnings: 0
    }
  };
}

const eligibility: ApplyEligibility = {
  runId: result.runId, eligible: true, checks: [{ id: "final", label: "Final attempt", status: "pass", detail: "Final." }],
  targetRepository: "/tmp/project", targetBranch: "main", targetRevision: "target", closureRunIds: [result.runId], fingerprint: "fingerprint"
};

const applyPreview: ApplyPreview = {
  ...eligibility, preflight: "clean", conflicts: [], strategy: "preflight-squash-cherry-pick",
  changedFiles: 1, additions: 2, deletions: 1, highRiskReasons: ["Target branch advanced after the result source revision."]
};

function promotion(kind: "apply" | "discard", status: "succeeded" | "discarded"): PromotionRecord {
  return {
    schemaVersion: 2, promotionId: `promotion-${kind}`, kind, status, runId: result.runId, includedRunIds: [result.runId],
    repositoryId: "repository", conflictPaths: [], startedAt: now, updatedAt: now, completedAt: now,
    owner: { pid: 1, hostname: "host", startedAt: now }, lifecycle: [{ status, at: now }]
  };
}

async function waitForFrame(lastFrame: () => string | undefined, text: string): Promise<string> {
  for (let index = 0; index < 200; index += 1) {
    const frame = lastFrame() ?? "";
    if (frame.includes(text)) return frame;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Frame never contained ${text}:\n${lastFrame() ?? ""}`);
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 50));

function baseService(overrides: Partial<TuiDataService> = {}): TuiDataService {
  return {
    async loadSnapshot() { return snapshot(); },
    async loadAttempt() { throw new Error("not used"); },
    async loadLogPreview(relativePath) { return { path: relativePath, status: "missing", text: "", totalBytes: 0, readBytes: 0, truncated: false }; },
    async loadResultSummary() { return summary; },
    ...overrides
  };
}

async function openResult(view: ReturnType<typeof render>): Promise<void> {
  await waitForFrame(view.lastFrame, "unapplied results");
  view.stdin.write("\t");
  await pause();
  view.stdin.write("\r");
  await waitForFrame(view.lastFrame, "Filter: Unapplied");
  await pause();
  view.stdin.write("\r");
  await waitForFrame(view.lastFrame, "Result summary");
  await pause();
}

describe("change review TUI keyboard workflow", () => {
  it("requires elevated-risk acknowledgement before applying a fresh preview", async () => {
    const applyReviewedResult = vi.fn(async (_runId: string, _fingerprint: string, onProgress?: (stage: string) => void) => {
      onProgress?.("applying");
      return promotion("apply", "succeeded");
    });
    const service = baseService({
      async inspectApplyEligibility() { return eligibility; },
      async previewApplyResult() { return applyPreview; },
      applyReviewedResult
    });
    const view = render(<AriadneTui service={service} color={false} unicode dimensions={{ width: 100, height: 28 }} />);
    await openResult(view);

    view.stdin.write("a");
    await waitForFrame(view.lastFrame, "Eligible to preflight");
    await pause();
    view.stdin.write("\r");
    await waitForFrame(view.lastFrame, "Preflight: clean");
    await pause();
    view.stdin.write("\r");
    await waitForFrame(view.lastFrame, "[ ] Space acknowledges elevated risk");
    await pause();
    view.stdin.write("\r");
    expect(await waitForFrame(view.lastFrame, "Acknowledge the elevated risk")).toContain("Space");
    expect(applyReviewedResult).not.toHaveBeenCalled();

    view.stdin.write(" ");
    await waitForFrame(view.lastFrame, "[x] Space acknowledges elevated risk");
    view.stdin.write("\r");
    await waitForFrame(view.lastFrame, "Result applied to the target repository");
    expect(applyReviewedResult).toHaveBeenCalledWith(result.runId, "fingerprint", expect.any(Function), expect.any(AbortSignal));
    view.unmount();
  });

  it("previews and confirms discard from the result screen", async () => {
    const discardReviewedResult = vi.fn(async () => promotion("discard", "discarded"));
    const service = baseService({
      async previewDiscardResult() {
        return { runId: result.runId, eligible: true, alreadyDiscarded: false, resultRef: "refs/ariadne/results/run-final", workspaceId: workspace.workspaceId, workspaceState: "retained", removesWorkspace: true, preserves: ["history"], blockers: [] };
      },
      discardReviewedResult
    });
    const view = render(<AriadneTui service={service} color={false} unicode dimensions={{ width: 100, height: 28 }} />);
    await openResult(view);
    view.stdin.write("x");
    await waitForFrame(view.lastFrame, "Discard preview");
    await pause();
    view.stdin.write("\r");
    await waitForFrame(view.lastFrame, "Discard confirmation");
    await pause();
    view.stdin.write("\r");
    await waitForFrame(view.lastFrame, "immutable history and review artifacts were preserved");
    expect(discardReviewedResult).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("keeps cleanup dry-run separate from confirmed workspace cleanup", async () => {
    const cleanupPreview: WorkspaceCleanupPreview = {
      workspaceId: workspace.workspaceId, eligible: true, blockers: [], removes: ["managed checkout"], preserves: ["history"], estimatedBytes: 1024, missingDirectory: false
    };
    const cleanWorkspace = vi.fn(async () => ({
      action: { schemaVersion: 1 as const, actionId: "action-1", kind: "workspace-cleanup" as const, status: "succeeded" as const, repositoryId: "repository", startedAt: now, completedAt: now, owner: { pid: 1, hostname: "host", startedAt: now }, workspaceIds: [workspace.workspaceId], outcomes: [] },
      cleaned: [{ ...workspace, state: "removed", physicalState: "missing" as const }], skipped: [], failed: []
    }));
    const service = baseService({ async previewWorkspaceCleanup() { return cleanupPreview; }, cleanWorkspace });
    const view = render(<AriadneTui service={service} color={false} unicode dimensions={{ width: 100, height: 28 }} />);
    await waitForFrame(view.lastFrame, "retained worktrees");
    view.stdin.write("\t");
    await pause();
    for (let index = 0; index < 5; index += 1) { view.stdin.write("j"); await pause(); }
    view.stdin.write("\r");
    await waitForFrame(view.lastFrame, "Managed workspaces");
    await pause();
    view.stdin.write("d");
    await waitForFrame(view.lastFrame, "Dry run · eligible");
    expect(cleanWorkspace).not.toHaveBeenCalled();
    await pause();
    view.stdin.write("\r");
    await waitForFrame(view.lastFrame, "Cleanup confirmation");
    await pause();
    view.stdin.write("\r");
    await waitForFrame(view.lastFrame, "1 cleaned, 0 skipped, 0 failed");
    expect(cleanWorkspace).toHaveBeenCalledOnce();
    view.unmount();
  });
});
