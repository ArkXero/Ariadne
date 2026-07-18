import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  ActiveWorkflowRegistry,
  createWorkflowPlanPreview,
  inspectWorkflowOptions,
  previewRerunWorkflow,
  previewResumeWorkflow,
  startWorkflowExecution
} from "../src/core/workflow-application.js";
import type { WorkflowRuntimeEvent } from "../src/core/workflow-runtime.js";
import { cleanupTempDirs, initGit, tempDir, writeProject } from "./helpers.js";

afterEach(cleanupTempDirs);

async function project(agentSource = "process.stdin.resume()") {
  const cwd = await tempDir("ariadne-application-");
  await writeProject(cwd, { agentArgs: ["-e", agentSource], tasks: [{ id: "a" }] });
  await writeFile(path.join(cwd, ".gitignore"), ".ariadne/runs/\n.ariadne/batches/\n.ariadne/workspaces/\n.ariadne/control/\n");
  await initGit(cwd, {});
  return cwd;
}

async function waitFor(events: WorkflowRuntimeEvent[], type: WorkflowRuntimeEvent["type"]): Promise<void> {
  for (let index = 0; index < 400 && !events.some((event) => event.type === type); index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(events.some((event) => event.type === type)).toBe(true);
}

describe("workflow application service", () => {
  it("inspects recognized metadata and creates a dependency-aware plan without launching", async () => {
    const cwd = await project();
    await writeFile(path.join(cwd, ".ariadne", "tasks", "a.yml"), [
      "id: a", "name: Foundation", "prompt: inspect", "workspaceMode: read-only", "metadata:", "  description: Read the foundation.", "  group: analysis", "  tags: [safe, fast]", ""
    ].join("\n"));
    await writeFile(path.join(cwd, ".ariadne", "tasks", "b.yml"), "id: b\nname: Build\nprompt: build\ndependsOn: [a]\nretry: {attempts: 3, delayMs: 25, backoff: exponential}\n");

    const inspection = await inspectWorkflowOptions({ cwd });
    expect(inspection.tasks).toContainEqual(expect.objectContaining({ id: "a", description: "Read the foundation.", group: "analysis", tags: ["safe", "fast"], workspaceMode: "read-only" }));
    const preview = await createWorkflowPlanPreview({ cwd, taskIds: ["b"], concurrency: 2, failureMode: "fail-fast" });
    expect(preview.plan.selectedRoots).toEqual(["b"]);
    expect(preview.plan.order).toEqual(["a", "b"]);
    expect(preview.plan.tasks).toEqual([
      expect.objectContaining({ id: "a", selected: false, level: 0 }),
      expect.objectContaining({ id: "b", selected: true, level: 1, retry: { attempts: 3, delayMs: 25, backoff: "exponential" } })
    ]);
    expect(preview.plan.failureMode).toBe("fail-fast");
    await writeFile(path.join(cwd, "dirty.txt"), "uncommitted source change\n");
    const dirtyWorktree = await createWorkflowPlanPreview({ cwd, taskIds: ["b"], isolation: "worktree" });
    expect(dirtyWorktree.blockers).toContainEqual(expect.objectContaining({ code: "DIRTY_WORKTREE_BASE", category: "repository_validation" }));
    const acknowledged = await createWorkflowPlanPreview({ cwd, taskIds: ["b"], isolation: "worktree", allowDirtyBase: true });
    expect(acknowledged.blockers).not.toContainEqual(expect.objectContaining({ code: "DIRTY_WORKTREE_BASE" }));
    expect(acknowledged.warnings.join(" ")).toContain("Dirty primary checkout");
  });

  it("streams launch events and makes cancellation idempotent during agent execution", async () => {
    const cwd = await project("process.stdin.resume(); console.log('agent ready'); setInterval(() => {}, 1000)");
    const execution = await startWorkflowExecution({ kind: "run", cwd, taskIds: ["a"] });
    const events: WorkflowRuntimeEvent[] = [];
    execution.subscribe((event) => { events.push(event); });
    await waitFor(events, "process.started");
    const first = execution.requestCancellation("test cancellation");
    const second = execution.requestCancellation("duplicate cancellation");
    expect(first).toBe(second);
    const batch = await first;
    await waitFor(events, "batch.completed");

    expect(batch.batchStatus).toBe("interrupted");
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "process.started", phase: "agent" }),
      expect.objectContaining({ type: "batch.cancellation_requested" }),
      expect.objectContaining({ type: "batch.cancellation_progress", stage: "processes-terminating" }),
      expect.objectContaining({ type: "batch.completed", status: "interrupted" })
    ]));
  });

  it("emits agent and verification process lifecycles as distinct phases", async () => {
    const cwd = await project("process.stdin.resume(); console.log('agent output')");
    const config = await readFile(path.join(cwd, "ariadne.yml"), "utf8");
    await writeFile(path.join(cwd, "ariadne.yml"), config.replace(
      "  commands: []",
      "  commands:\n    - kind: exec\n      file: node\n      args: [\"-e\", \"console.log('verification output')\"]"
    ));
    const execution = await startWorkflowExecution({ kind: "run", cwd });
    const events: WorkflowRuntimeEvent[] = [];
    execution.subscribe((event) => { events.push(event); });
    const batch = await execution.completion;
    await waitFor(events, "batch.completed");
    const phases = events.filter((event) => event.type === "process.started").map((event) => event.type === "process.started" ? event.phase : "");
    expect(batch.batchStatus).toBe("succeeded");
    expect(phases).toEqual(["agent", "verification"]);
    expect(events.filter((event) => event.type === "process.output").map((event) => event.type === "process.output" ? event.chunk : "").join("")).toContain("verification output");
  });

  it("cancels an active verification process and finalizes the batch", async () => {
    const cwd = await project("process.stdin.resume()");
    const config = await readFile(path.join(cwd, "ariadne.yml"), "utf8");
    await writeFile(path.join(cwd, "ariadne.yml"), config.replace(
      "  commands: []",
      "  commands:\n    - kind: exec\n      file: node\n      args: [\"-e\", \"setInterval(() => console.log('verifying'), 25)\"]"
    ));
    const execution = await startWorkflowExecution({ kind: "run", cwd });
    const events: WorkflowRuntimeEvent[] = [];
    execution.subscribe((event) => { events.push(event); });
    for (let index = 0; index < 400 && !events.some((event) => event.type === "process.started" && event.phase === "verification"); index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(events.some((event) => event.type === "process.started" && event.phase === "verification")).toBe(true);

    const batch = await execution.requestCancellation("cancel verification");
    await waitFor(events, "batch.completed");
    expect(batch.batchStatus).toBe("interrupted");
    expect(events).toContainEqual(expect.objectContaining({ type: "process.completed", phase: "verification", status: "interrupted" }));
  });

  it("cancels a scheduled retry without launching another attempt", async () => {
    const cwd = await project("process.stdin.resume(); process.exitCode = 1");
    await writeFile(path.join(cwd, ".ariadne", "tasks", "a.yml"), [
      "id: a", "name: Retry", "prompt: retry", "retry:", "  attempts: 2", "  delayMs: 5000", "  backoff: fixed", ""
    ].join("\n"));
    const execution = await startWorkflowExecution({ kind: "run", cwd });
    const events: WorkflowRuntimeEvent[] = [];
    execution.subscribe((event) => { events.push(event); });
    await waitFor(events, "task.retry_scheduled");

    const batch = await execution.requestCancellation("cancel retry delay");
    await waitFor(events, "batch.completed");
    expect(batch.batchStatus).toBe("interrupted");
    expect(batch.tasks[0]?.attempts).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ type: "batch.cancellation_progress", stage: "retry-delays-cancelled" }));
  });

  it("keeps one active registry workflow and returns persisted planning failures through the handle", async () => {
    const missing = await tempDir("ariadne-missing-config-");
    const failed = await startWorkflowExecution({ kind: "run", cwd: missing });
    expect((await failed.completion).batchStatus).toBe("failed");

    const cwd = await project("process.stdin.resume(); setInterval(() => {}, 1000)");
    const registry = new ActiveWorkflowRegistry();
    const active = await registry.start({ kind: "run", cwd });
    await expect(registry.start({ kind: "run", cwd })).rejects.toMatchObject({ code: "TUI_WORKFLOW_ACTIVE" });
    await registry.cancel("registry test");
    expect(active.latestSnapshot().state).toBe("completed");
  });

  it("previews resume and each rerun mode against current configuration without mutating the source", async () => {
    const cwd = await project("process.stdin.resume(); process.exitCode = process.env.ARIADNE_TASK_ID === 'a' ? 7 : 0");
    await writeFile(path.join(cwd, ".ariadne", "tasks", "a.yml"), "id: a\nprompt: a\n");
    await writeFile(path.join(cwd, ".ariadne", "tasks", "b.yml"), "id: b\nprompt: b\ndependsOn: [a]\n");
    await writeFile(path.join(cwd, ".ariadne", "tasks", "c.yml"), "id: c\nprompt: c\ndependsOn: [b]\n");
    await writeFile(path.join(cwd, ".ariadne", "tasks", "d.yml"), "id: d\nprompt: d\n");
    const source = await (await startWorkflowExecution({ kind: "run", cwd, taskIds: ["c", "d"] })).completion;
    const sourceRaw = JSON.stringify(source);

    const resume = await previewResumeWorkflow({ cwd, sourceBatchId: source.batchId });
    const failed = await previewRerunWorkflow({ cwd, sourceBatchId: source.batchId, mode: "failed" });
    const branch = await previewRerunWorkflow({ cwd, sourceBatchId: source.batchId, mode: "failed-branch" });
    const all = await previewRerunWorkflow({ cwd, sourceBatchId: source.batchId, mode: "all" });

    expect(resume).toMatchObject({ compatible: true, reusableTaskIds: ["d"] });
    expect(resume.requeuedTaskIds).toEqual(expect.arrayContaining(["a", "b", "c"]));
    expect(failed.selectedSourceTaskIds).toEqual(["a"]);
    expect(branch.selectedSourceTaskIds).toEqual(["c"]);
    expect(all.selectedSourceTaskIds).toEqual(["c", "d"]);
    expect(JSON.stringify(source)).toBe(sourceRaw);
  });
});
