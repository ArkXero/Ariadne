import os from "node:os";
import path from "node:path";
import process from "node:process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { DEFAULT_IO_CONCURRENCY, mapWithConcurrency } from "../dist/core/bounded-map.js";
import { loadRunHistory } from "../dist/core/run-reader.js";
import { listWorkspaces } from "../dist/core/workspace-manager.js";
import { WorkflowGraph } from "../dist/core/workflow-graph.js";
import { buildWorkflowPlan } from "../dist/core/workflow-planner.js";
import { readLogPreview, MAX_LOG_PREVIEW_BYTES } from "../dist/tui/log-preview.js";
import { AriadneTuiService } from "../dist/tui/services.js";

const root = await mkdtemp(path.join(os.tmpdir(), "ariadne-release-profile-"));
const runsRoot = path.join(root, ".ariadne", "runs");
const worktreesRoot = path.join(root, ".ariadne", "worktrees");
const measurements = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function measure(name, scale, operation) {
  const before = process.memoryUsage();
  const started = performance.now();
  await operation();
  const after = process.memoryUsage();
  measurements.push({
    name,
    scale,
    durationMs: Math.round((performance.now() - started) * 100) / 100,
    heapUsedBytes: after.heapUsed,
    heapDeltaBytes: after.heapUsed - before.heapUsed,
    rssBytes: after.rss
  });
}

function legacyRun(index) {
  const startedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString();
  return `${JSON.stringify({ version: 1, startedAt, completedAt: startedAt, durationMs: 0, results: [] })}\n`;
}

function workspace(index) {
  const workspaceId = `ws-profile-${String(index).padStart(5, "0")}`;
  const now = "2026-01-01T00:00:00.000Z";
  return {
    workspaceId,
    record: {
      schemaVersion: 1,
      workspaceId,
      runId: `run-${index}`,
      batchId: `batch-${index}`,
      planId: "profile-plan",
      taskId: `task-${index}`,
      attempt: 1,
      repositoryId: "profile-repository",
      sourceRevision: "0000000000000000000000000000000000000000",
      path: `.ariadne/worktrees/${workspaceId}/checkout`,
      metadataPath: `.ariadne/worktrees/${workspaceId}/workspace.json`,
      state: "removed",
      retention: "never",
      createdAt: now,
      updatedAt: now,
      owner: { pid: process.pid, hostname: os.hostname(), startedAt: now },
      lifecycle: [{ state: "removed", at: now }],
      cleanupAt: now
    }
  };
}

function workflowConfig() {
  return {
    version: 4,
    sourceVersion: 4,
    agent: { command: { kind: "exec", file: "node", args: ["agent.mjs"] }, timeout_ms: 1_000 },
    tasks: { directory: ".ariadne/tasks" },
    verification: { commands: [], timeout_ms: 1_000 },
    execution: {
      termination_grace_ms: 100,
      concurrency: 32,
      failure_mode: "continue",
      isolation: "shared",
      worktree: { retention: "on-failure", preparation: { commands: [], timeout_ms: 600_000 } }
    },
    checks: { forbidden_files: [], forbidden_commands: [] }
  };
}

try {
  await mkdir(runsRoot, { recursive: true });
  let written = 0;
  for (const scale of [10, 100, 1_000, 10_000]) {
    const indexes = Array.from({ length: scale - written }, (_, offset) => written + offset);
    await mapWithConcurrency(indexes, DEFAULT_IO_CONCURRENCY, (index) => writeFile(path.join(runsRoot, `profile-${String(index).padStart(5, "0")}.json`), legacyRun(index)));
    written = scale;
    await measure("history-load", scale, async () => {
      const history = await loadRunHistory(root);
      assert(history.records.length === scale && history.records.every((record) => record.ok), `History profile loaded ${history.records.length}/${scale} records.`);
    });

    if (scale === 1_000) {
      const values = Array.from({ length: 1_000 }, (_, index) => workspace(index));
      await mapWithConcurrency(values, DEFAULT_IO_CONCURRENCY, async ({ workspaceId, record }) => {
        const directory = path.join(worktreesRoot, workspaceId);
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, "workspace.json"), `${JSON.stringify(record)}\n`);
      });
      await measure("worktree-list", 1_000, async () => {
        assert((await listWorkspaces(root)).length === 1_000, "Worktree profile did not load every record.");
      });
      await measure("tui-snapshot", 1_000, async () => {
        const snapshot = await new AriadneTuiService(root).loadSnapshot();
        assert(snapshot.tasks.length === 0 && snapshot.warnings.length >= 1, "TUI profile returned an inconsistent legacy snapshot.");
      });
    }
  }

  await measure("workflow-plan", 10_000, async () => {
    const tasks = Array.from({ length: 10_000 }, (_, index) => {
      const id = `task-${String(index).padStart(5, "0")}`;
      return { id, name: id, file: `${id}.yml`, prompt: id, dependsOn: [], workspaceMode: "read-only", retry: { attempts: 1, delayMs: 0, backoff: "fixed" } };
    });
    const plan = buildWorkflowPlan({ graph: new WorkflowGraph(tasks.toReversed()), config: workflowConfig(), createdAt: new Date("2026-01-01T00:00:00.000Z") });
    assert(plan.order.length === 10_000 && plan.order[0] === "task-00000" && plan.order.at(-1) === "task-09999", "Wide workflow profile returned a nondeterministic plan.");
  });

  const logPath = path.join(root, "large.log");
  await writeFile(logPath, `${"early-output\n"}${"x".repeat(4 * 1024 * 1024)}\nrecent-output\n`);
  await measure("log-preview", 4 * 1024 * 1024, async () => {
    const preview = await readLogPreview(root, "large.log");
    assert(preview.status === "ready" && preview.truncated && preview.readBytes <= MAX_LOG_PREVIEW_BYTES && preview.text.includes("recent-output"), "Large log preview was not safely bounded.");
  });

  process.stdout.write(`${JSON.stringify({ profileVersion: 1, measurements }, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
