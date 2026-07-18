import { afterEach, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/core/config.js";
import { loadTasks } from "../src/core/task-loader.js";
import { WorkflowGraph } from "../src/core/workflow-graph.js";
import { buildWorkflowPlan } from "../src/core/workflow-planner.js";
import { cleanupTempDirs, tempDir } from "./helpers.js";
import type { AriadneConfig, AriadneTask } from "../src/types/index.js";

afterEach(cleanupTempDirs);

function task(id: string, dependsOn: string[] = []): AriadneTask {
  return { id, name: id, file: `${id}.yml`, prompt: id, dependsOn, workspaceMode: "mutable", retry: { attempts: 1, delayMs: 0, backoff: "fixed" } };
}

function config(): AriadneConfig {
  return {
    version: 4, sourceVersion: 4,
    agent: { command: { kind: "exec", file: "node", args: ["agent.mjs"] }, timeout_ms: 1_000 },
    tasks: { directory: ".ariadne/tasks" }, verification: { commands: [], timeout_ms: 1_000 },
    execution: { termination_grace_ms: 100, concurrency: 2, failure_mode: "continue", isolation: "shared", worktree: { retention: "on-failure", preparation: { commands: [], timeout_ms: 600_000 } } },
    checks: { forbidden_files: [], forbidden_commands: [] }
  };
}

describe("workflow graph and planning", () => {
  it("builds dependency closure, levels, and deterministic order for a diamond", () => {
    const graph = new WorkflowGraph([task("package", ["integration"]), task("unit"), task("typecheck"), task("integration", ["unit", "typecheck"])]);
    expect(graph.closure(["PACKAGE"])).toEqual(["integration", "package", "typecheck", "unit"]);
    expect(graph.topological(graph.closure(["package"]))).toEqual({ order: ["typecheck", "unit", "integration", "package"], levels: [["typecheck", "unit"], ["integration"], ["package"]] });
    expect(graph.dependentIds("unit")).toEqual(["integration"]);
  });

  it("produces the same plan for randomized definition order", () => {
    const values = [task("c", ["a", "b"]), task("a"), task("b")];
    const first = buildWorkflowPlan({ graph: new WorkflowGraph(values), config: config(), selectedIds: ["c"], createdAt: new Date("2026-01-01T00:00:00Z") });
    const second = buildWorkflowPlan({ graph: new WorkflowGraph([values[2], values[0], values[1]]), config: config(), selectedIds: ["C"], createdAt: new Date("2026-01-02T00:00:00Z") });
    expect(second.planId).toBe(first.planId);
    expect(second.order).toEqual(first.order);
    expect(second.levels).toEqual(first.levels);
    expect(second.concurrencyGroups).toEqual(first.concurrencyGroups);
    expect(second.createdAt).not.toBe(first.createdAt);
  });

  it("owns immutable task data instead of retaining caller metadata", () => {
    const original = { ...task("a"), metadata: { nested: { value: 1 } } };
    const graph = new WorkflowGraph([original]);
    original.metadata.nested.value = 2;
    expect(graph.require("a").metadata).toEqual({ nested: { value: 1 } });
    expect(Object.isFrozen((graph.require("a").metadata as { nested: object }).nested)).toBe(true);
  });

  it("redacts secret-bearing verification arguments from plan output", () => {
    const value = config();
    value.verification.commands = [{ kind: "exec", file: "tool", args: ["--token", "do-not-persist"] }];
    const plan = buildWorkflowPlan({ graph: new WorkflowGraph([task("a")]), config: value });
    expect(plan.tasks[0].verification).toEqual([{ kind: "exec", file: "tool", args: ["--token", "[REDACTED]"] }]);
    expect(JSON.stringify(plan)).not.toContain("do-not-persist");
  });

  it("describes possible parallel groups within the effective concurrency bound", () => {
    const values = ["a", "b", "c"].map((id) => ({ ...task(id), workspaceMode: "read-only" as const }));
    const plan = buildWorkflowPlan({ graph: new WorkflowGraph(values), config: config() });
    expect(plan.concurrencyGroups).toEqual([["a", "b"], ["c"]]);
  });

  it("plans 10,000 independent tasks deterministically without quadratic scans", () => {
    const values = Array.from({ length: 10_000 }, (_, index) => ({ ...task(`task-${String(index).padStart(5, "0")}`), workspaceMode: "read-only" as const }));
    const plan = buildWorkflowPlan({ graph: new WorkflowGraph(values.toReversed()), config: { ...config(), execution: { ...config().execution, concurrency: 32 } }, createdAt: new Date("2026-01-01T00:00:00Z") });
    expect(plan.order).toHaveLength(10_000);
    expect(plan.order[0]).toBe("task-00000");
    expect(plan.order.at(-1)).toBe("task-09999");
    expect(plan.levels).toHaveLength(1);
    expect(plan.concurrencyGroups.every((group) => group.length <= 32)).toBe(true);
  });

  it.each([
    ["duplicate task ID", [task("A"), task("a")], "TASK_ID_DUPLICATE"],
    ["missing dependency", [task("a", ["missing"])], "TASK_DEPENDENCY_NOT_FOUND"],
    ["self dependency", [task("a", ["A"])], "TASK_DEPENDENCY_SELF"],
    ["duplicate dependency", [task("a"), task("b", ["a", "A"])], "TASK_DEPENDENCY_DUPLICATE"],
    ["cycle", [task("a", ["c"]), task("b", ["a"]), task("c", ["b"])], "TASK_DEPENDENCY_CYCLE"]
  ])("rejects %s with structured diagnostics", (_name, tasks, code) => {
    expect(() => new WorkflowGraph(tasks as AriadneTask[])).toThrow(expect.objectContaining({ code }));
  });

  it("loads strict v3 orchestration fields and keeps v2 tasks dependency-free", async () => {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, ".ariadne", "tasks"), { recursive: true });
    await writeFile(path.join(cwd, "ariadne.yml"), `version: 3\nagent:\n  command: {kind: exec, file: node, args: []}\nexecution: {concurrency: 4, failure_mode: fail-fast}\n`);
    await writeFile(path.join(cwd, ".ariadne", "tasks", "a.yml"), `id: a\ndependsOn: []\nparallelSafe: true\nretry: {attempts: 3, delayMs: 5, backoff: exponential}\nverify: []\nprompt: test\n`);
    const loaded = await loadConfig(cwd);
    const tasks = await loadTasks(cwd, loaded.config.tasks.directory, loaded.config.sourceVersion);
    expect(loaded.config.execution).toMatchObject({ concurrency: 4, failure_mode: "fail-fast" });
    expect(tasks[0]).toMatchObject({ dependsOn: [], workspaceMode: "read-only", retry: { attempts: 3, delayMs: 5, backoff: "exponential" }, verify: [] });

    await writeFile(path.join(cwd, "ariadne.yml"), `version: 2\nagent:\n  command: {kind: exec, file: node, args: []}\n`);
    await writeFile(path.join(cwd, ".ariadne", "tasks", "a.yml"), `id: a\nprompt: test\n`);
    const v2 = await loadConfig(cwd);
    expect((await loadTasks(cwd, v2.config.tasks.directory, v2.config.sourceVersion))[0]).toMatchObject({ dependsOn: [], workspaceMode: "mutable", retry: { attempts: 1 } });
    expect(v2.warnings[0]).toContain("version 2");
  });
});
