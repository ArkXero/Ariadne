import path from "node:path";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import fs from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";
import { runWorkflow } from "../src/core/workflow-runner.js";
import { AriadneTuiService } from "../src/tui/services.js";
import { cleanupTempDirs, tempDir, writeProject } from "./helpers.js";

afterEach(cleanupTempDirs);

async function writeLegacyHistory(cwd: string): Promise<void> {
  await mkdir(path.join(cwd, ".ariadne", "runs"), { recursive: true });
  const processResult = {
    command: "node agent.js", exitCode: 0, stdout: "ok", stderr: "", runtimeMs: 10,
    startedAt: "2026-07-16T00:00:00.000Z", completedAt: "2026-07-16T00:00:00.010Z", timedOut: false
  };
  await writeFile(path.join(cwd, ".ariadne", "runs", "legacy.json"), JSON.stringify({
    startedAt: "2026-07-16T00:00:00.000Z", completedAt: "2026-07-16T00:00:01.000Z", durationMs: 1_000,
    results: [
      { task: { id: "first", name: "First", file: "first.yml" }, agent: processResult, verification: [], score: { passed: true } },
      { task: { id: "second", name: "Second", file: "second.yml" }, agent: processResult, verification: [], score: { passed: false, status: "policy_failed" } }
    ]
  }));
}

describe("TUI application services", () => {
  it("opens a safe empty dashboard without configuration or history", async () => {
    const cwd = await tempDir();
    const snapshot = await new AriadneTuiService(cwd).loadSnapshot();
    expect(snapshot).toMatchObject({ configuration: "missing", batches: [], tasks: [] });
    expect(snapshot.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining(["configuration-missing", "history-empty"]));
  });

  it("flattens every task from a legacy multi-task run into stable history entries", async () => {
    const cwd = await tempDir();
    await writeLegacyHistory(cwd);
    const service = new AriadneTuiService(cwd);
    const first = await service.loadSnapshot();
    const second = await service.loadSnapshot();
    expect(first.tasks.map((task) => task.taskId)).toEqual(["first", "second"]);
    expect(second.tasks.map((task) => task.key)).toEqual(first.tasks.map((task) => task.key));
    expect(first.tasks.every((task) => task.source === "legacy" && task.finalAttempt === 1)).toBe(true);
  });

  it("loads the selected task within a legacy attempt detail", async () => {
    const cwd = await tempDir();
    await writeLegacyHistory(cwd);
    const service = new AriadneTuiService(cwd);
    const snapshot = await service.loadSnapshot();
    const second = snapshot.tasks.find((task) => task.taskId === "second")!;
    const detail = await service.loadAttempt(second.attempts[0]!);
    expect(detail.taskIndex).toBe(1);
    expect(detail.report.tasks[detail.taskIndex]?.id).toBe("second");
  });

  it("uses batch attempt references and identifies the final modern attempt", async () => {
    const cwd = await tempDir();
    await writeProject(cwd);
    await runWorkflow({ cwd, configPath: "ariadne.yml" });
    const snapshot = await new AriadneTuiService(cwd).loadSnapshot();
    expect(snapshot.batches).toHaveLength(1);
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]).toMatchObject({ source: "batch", finalAttempt: 1, attempts: [{ source: "batch", final: true }] });
  });

  it("emits structured corrupt and future-record warnings", async () => {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, ".ariadne", "runs"), { recursive: true });
    await writeFile(path.join(cwd, ".ariadne", "runs", "corrupt.json"), "{broken");
    await writeFile(path.join(cwd, ".ariadne", "runs", "future.json"), JSON.stringify({ schemaVersion: 99, startedAt: "2026-07-16T00:00:00.000Z" }));
    const snapshot = await new AriadneTuiService(cwd).loadSnapshot();
    expect(snapshot.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining(["corrupt-record", "future-record"]));
  });

  it("reports a missing batch child with a structured code", async () => {
    const cwd = await tempDir();
    await writeProject(cwd);
    const batch = await runWorkflow({ cwd, configPath: "ariadne.yml" });
    const manifest = path.join(cwd, batch.artifacts.manifest);
    const json = JSON.parse(await readFile(manifest, "utf8"));
    json.tasks[0].attempts[0].manifest = ".ariadne/runs/missing/run.json";
    await writeFile(manifest, JSON.stringify(json));
    const snapshot = await new AriadneTuiService(cwd).loadSnapshot();
    expect(snapshot.warnings.some((warning) => warning.code === "missing-child")).toBe(true);
  });

  it("reports missing process artifacts without failing history loading", async () => {
    const cwd = await tempDir();
    await writeProject(cwd);
    const batch = await runWorkflow({ cwd, configPath: "ariadne.yml" });
    const attempt = batch.tasks[0]!.attempts[0]!;
    const run = JSON.parse(await readFile(path.join(cwd, attempt.manifest), "utf8"));
    const artifact = run.results[0].agent.stdoutArtifact;
    await unlink(path.join(cwd, artifact));
    const snapshot = await new AriadneTuiService(cwd).loadSnapshot();
    expect(snapshot.warnings.some((warning) => warning.code === "missing-artifact")).toBe(true);
  });

  it("reports missing managed worktrees while preserving metadata", async () => {
    const cwd = await tempDir();
    const metadata = path.join(cwd, ".ariadne", "worktrees", "ws-1", "workspace.json");
    await fs.ensureDir(path.dirname(metadata));
    const now = "2026-07-16T00:00:00.000Z";
    await writeFile(metadata, JSON.stringify({
      schemaVersion: 1, workspaceId: "ws-1", runId: "r1", batchId: "b1", planId: "p1", taskId: "t1", attempt: 1,
      repositoryId: "repo", sourceRevision: "abc", path: ".ariadne/worktrees/ws-1/checkout", metadataPath: ".ariadne/worktrees/ws-1/workspace.json",
      state: "retained", retention: "always", createdAt: now, updatedAt: now, owner: { pid: process.pid, hostname: "different-host", startedAt: now },
      lifecycle: [{ state: "retained", at: now }]
    }));
    const snapshot = await new AriadneTuiService(cwd).loadSnapshot();
    expect(snapshot.workspaces).toHaveLength(1);
    expect(snapshot.warnings.some((warning) => warning.code === "missing-worktree" && warning.recordId === "ws-1")).toBe(true);
  });

  it("refuses attempt manifests outside the project root", async () => {
    const cwd = await tempDir();
    const service = new AriadneTuiService(cwd);
    await expect(service.loadAttempt({
      key: "unsafe", manifestPath: "../run.json", manifest: "../run.json", source: "legacy", final: true, attempt: 1, runId: "r1",
      status: "failed", outcome: "internal_failed", score: 0, startedAt: "2026-07-16T00:00:00.000Z", completedAt: "2026-07-16T00:00:00.000Z", durationMs: 0, retryEligible: false
    })).rejects.toThrow("leaves the project root");
  });
});
