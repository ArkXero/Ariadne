import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { runWorkflow } from "../src/core/workflow-runner.js";
import { exitCodeForBatch } from "../src/commands/run.js";
import { cleanupTempDirs, initGit, tempDir } from "./helpers.js";

afterEach(cleanupTempDirs);

interface FixtureTask { id: string; dependsOn?: string[]; parallelSafe?: boolean; retry?: { attempts: number; delayMs: number; backoff: "fixed" | "exponential" }; verify?: unknown[] }

async function fixture(tasks: FixtureTask[], behavior: Record<string, Record<string, unknown>>, options: { concurrency?: number; failureMode?: string; checks?: string; agentTimeout?: number } = {}): Promise<string> {
  const cwd = await tempDir("ariadne-workflow-");
  await mkdir(path.join(cwd, ".ariadne", "tasks"), { recursive: true });
  await writeFile(path.join(cwd, ".gitignore"), ".ariadne/runs/\n.ariadne/batches/\n.ariadne/control/\n.env\n");
  await writeFile(path.join(cwd, "target.txt"), "initial\n");
  await writeFile(path.join(cwd, "behavior.json"), JSON.stringify(behavior));
  await writeFile(path.join(cwd, "agent.mjs"), `
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
const id = process.env.ARIADNE_TASK_ID;
const behavior = JSON.parse(await readFile("behavior.json", "utf8"))[id] ?? {};
await mkdir(".ariadne/control", { recursive: true });
const event = async (kind) => appendFile(".ariadne/control/events.jsonl", JSON.stringify({ id, kind, at: Date.now() }) + "\\n");
await event("start");
if (behavior.marker) await writeFile(".ariadne/control/marker", id);
if (behavior.gateCount) {
  await writeFile(".ariadne/control/" + id + ".ready", "ready\\n");
  while ((await readdir(".ariadne/control")).filter((name) => name.endsWith(".ready")).length < behavior.gateCount) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
if (behavior.timeoutOnce) {
  const counter = ".ariadne/control/" + id + ".timeout-count";
  const value = Number(await readFile(counter, "utf8").catch(() => "0")) + 1;
  await writeFile(counter, String(value));
  if (value === 1) await new Promise((resolve) => setTimeout(resolve, 5000));
}
if (behavior.delay) await new Promise((resolve) => setTimeout(resolve, behavior.delay));
if (behavior.mutate) await appendFile("target.txt", id + "\\n");
if (behavior.forbidden) await writeFile(".env", "fixture=true\\n");
if (behavior.reportedCommand) console.log("rm -rf reported-only");
if (behavior.failOnce) {
  const counter = ".ariadne/control/" + id + ".count";
  const value = Number(await readFile(counter, "utf8").catch(() => "0")) + 1;
  await writeFile(counter, String(value));
  if (value === 1) { await event("end"); process.exit(7); }
}
await event("end");
if (behavior.fail) process.exit(7);
`);
  await writeFile(path.join(cwd, "ariadne.yml"), `version: 4
agent:
  command: {kind: exec, file: node, args: [agent.mjs]}
  timeout_ms: ${options.agentTimeout ?? 2000}
tasks: {directory: .ariadne/tasks}
verification: {commands: [], timeout_ms: 1000}
execution:
  termination_grace_ms: 100
  concurrency: ${options.concurrency ?? 2}
  failure_mode: ${options.failureMode ?? "continue"}
  isolation: shared
  worktree:
    retention: on-failure
    preparation: {commands: [], timeout_ms: 600000}
checks:
${options.checks ?? "  forbidden_files: []\n  forbidden_commands: []"}
`);
  for (const task of tasks) await writeFile(path.join(cwd, ".ariadne", "tasks", `${task.id}.yml`), `${JSON.stringify({ id: task.id, name: task.id, prompt: task.id, dependsOn: task.dependsOn ?? [], workspaceMode: task.parallelSafe ? "read-only" : "mutable", retry: task.retry ?? { attempts: 1, delayMs: 0, backoff: "fixed" }, ...(task.verify ? { verify: task.verify } : {}) }, null, 2)}\n`);
  await initGit(cwd, {});
  return cwd;
}

async function events(cwd: string): Promise<Array<{ id: string; kind: string; at: number }>> {
  return (await readFile(path.join(cwd, ".ariadne", "control", "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

describe("workflow scheduler", () => {
  it("runs a linear chain in dependency order", async () => {
    const cwd = await fixture([{ id: "a" }, { id: "b", dependsOn: ["a"] }, { id: "c", dependsOn: ["b"] }], {});
    const batch = await runWorkflow({ cwd });
    expect(batch.batchStatus).toBe("succeeded");
    expect((await events(cwd)).filter((event) => event.kind === "start").map((event) => event.id)).toEqual(["a", "b", "c"]);
    expect(batch.tasks.every((task) => task.attempts.length === 1)).toBe(true);
  });

  it("runs only declared-safe tasks concurrently and respects the bound", async () => {
    const cwd = await fixture([{ id: "a", parallelSafe: true }, { id: "b", parallelSafe: true }, { id: "c", parallelSafe: true }], { a: { gateCount: 2 }, b: { gateCount: 2 }, c: {} }, { concurrency: 2, agentTimeout: 5_000 });
    const batch = await runWorkflow({ cwd });
    const values = await events(cwd);
    let active = 0;
    let maximum = 0;
    for (const event of values) {
      active += event.kind === "start" ? 1 : -1;
      maximum = Math.max(maximum, active);
    }
    expect(batch.batchStatus).toBe("succeeded");
    expect(maximum).toBe(2);
  });

  it("blocks failed dependents while continuing an independent branch", async () => {
    const cwd = await fixture([{ id: "a" }, { id: "b", dependsOn: ["a"] }, { id: "c" }], { a: { fail: true } });
    const batch = await runWorkflow({ cwd });
    expect(Object.fromEntries(batch.tasks.map((task) => [task.id, task.state]))).toEqual({ a: "failed", b: "blocked", c: "succeeded" });
    expect(batch.tasks.find((task) => task.id === "b")?.attempts).toHaveLength(0);
    expect(batch.tasks.find((task) => task.id === "b")?.blockReason?.dependencyId).toBe("a");
    expect(batch.batchStatus).toBe("partially_failed");
  });

  it("fail-fast stops unrelated tasks from launching", async () => {
    const cwd = await fixture([{ id: "a" }, { id: "b" }, { id: "c" }], { a: { fail: true } }, { failureMode: "fail-fast" });
    const batch = await runWorkflow({ cwd });
    expect(Object.fromEntries(batch.tasks.map((task) => [task.id, task.state]))).toEqual({ a: "failed", b: "skipped", c: "skipped" });
    expect((await events(cwd)).filter((event) => event.kind === "start").map((event) => event.id)).toEqual(["a"]);
  });

  it("persists an independent child run for every retry attempt", async () => {
    const cwd = await fixture([{ id: "a", retry: { attempts: 2, delayMs: 1, backoff: "fixed" } }], { a: { failOnce: true } });
    const batch = await runWorkflow({ cwd });
    const task = batch.tasks[0];
    expect(batch.batchStatus).toBe("succeeded_with_warnings");
    expect(task.state).toBe("succeeded");
    expect(task.attempts).toHaveLength(2);
    expect(new Set(task.attempts.map((attempt) => attempt.runId)).size).toBe(2);
    expect(task.attempts[0]).toMatchObject({ outcome: "agent_failed", retryEligible: true, retryDelayMs: 1 });
    expect(task.attempts[1].outcome).toBe("passed");
    for (const attempt of task.attempts) expect(await readFile(path.join(cwd, attempt.manifest), "utf8")).toContain(`"batchId": "${batch.batchId}"`);
  });

  it("does not retry policy failures", async () => {
    const cwd = await fixture([{ id: "a", retry: { attempts: 3, delayMs: 0, backoff: "fixed" } }], { a: { forbidden: true } }, { checks: "  forbidden_files: [.env]\n  forbidden_commands: []" });
    const batch = await runWorkflow({ cwd });
    expect(batch.tasks[0]).toMatchObject({ state: "failed", attempts: [{ outcome: "policy_failed", retryEligible: false }] });
  });

  it("marks a successful workflow as warned when child policies warn", async () => {
    const cwd = await fixture([{ id: "a" }], { a: { reportedCommand: true } }, { checks: "  forbidden_files: []\n  forbidden_commands: ['rm -rf']" });
    const batch = await runWorkflow({ cwd });
    expect(batch.tasks[0]).toMatchObject({ state: "succeeded", finalOutcome: "passed" });
    expect(batch.tasks[0].warnings.join(" ")).toContain("commands.forbidden");
    expect(batch.batchStatus).toBe("succeeded_with_warnings");
  });

  it("uses deterministic exponential delays and exhausts the attempt bound", async () => {
    const cwd = await fixture([{ id: "a", retry: { attempts: 3, delayMs: 1, backoff: "exponential" } }], { a: { fail: true } });
    const batch = await runWorkflow({ cwd });
    expect(batch.tasks[0].attempts).toHaveLength(3);
    expect(batch.tasks[0].attempts.map((attempt) => attempt.retryDelayMs)).toEqual([1, 2, undefined]);
    expect(batch.tasks[0].state).toBe("failed");
  });

  it("retries a cleaned-up timeout and then succeeds", async () => {
    const cwd = await fixture([{ id: "a", retry: { attempts: 2, delayMs: 0, backoff: "fixed" } }], { a: { timeoutOnce: true } }, { agentTimeout: 2_000 });
    const batch = await runWorkflow({ cwd });
    expect(batch.tasks[0].attempts.map((attempt) => attempt.outcome)).toEqual(["timeout", "passed"]);
    expect(batch.tasks[0].state).toBe("succeeded");
  });

  it("retries verification failure with task-local verification commands", async () => {
    const cwd = await fixture([{ id: "a", retry: { attempts: 2, delayMs: 0, backoff: "fixed" } }], {});
    await writeFile(path.join(cwd, "verify.mjs"), `import { readFile, writeFile } from "node:fs/promises"; const p=".ariadne/control/verify-count"; const n=Number(await readFile(p,"utf8").catch(()=>0))+1; await writeFile(p,String(n)); if(n===1) process.exit(2);`);
    await writeFile(path.join(cwd, ".ariadne", "tasks", "a.yml"), `${JSON.stringify({ id: "a", prompt: "a", retry: { attempts: 2, delayMs: 0, backoff: "fixed" }, verify: [{ kind: "exec", file: "node", args: ["verify.mjs"] }] }, null, 2)}\n`);
    const batch = await runWorkflow({ cwd });
    expect(batch.tasks[0].attempts.map((attempt) => attempt.outcome)).toEqual(["verification_failed", "passed"]);
  });

  it("fails a declared-safe task that mutates during overlap", async () => {
    const cwd = await fixture([{ id: "a", parallelSafe: true }, { id: "b", parallelSafe: true }], { a: { mutate: true, delay: 20 }, b: { delay: 60 } }, { concurrency: 2 });
    const batch = await runWorkflow({ cwd });
    expect(batch.tasks.find((task) => task.id === "a")?.state).toBe("failed");
    expect(batch.tasks.find((task) => task.id === "b")?.state).toBe("failed");
    expect(batch.failures.some((failure) => failure.code === "PARALLEL_SAFETY_VIOLATION")).toBe(true);
  });

  it("preserves timeout precedence when a parallel-safety violation also occurs", async () => {
    const cwd = await fixture([{ id: "a", parallelSafe: true }, { id: "b", parallelSafe: true }], { a: { mutate: true }, b: { timeoutOnce: true } }, { concurrency: 2, agentTimeout: 500 });
    const batch = await runWorkflow({ cwd });
    expect(batch.tasks.find((task) => task.id === "b")?.finalOutcome).toBe("timeout");
    expect(batch.summary.outcome).toBe("timeout");
    expect(exitCodeForBatch(batch)).toBe(11);
  });

  it("cancels a retry delay and persists interruption", async () => {
    const cwd = await fixture([{ id: "a", retry: { attempts: 3, delayMs: 1000, backoff: "fixed" } }], { a: { fail: true, marker: true } });
    const controller = new AbortController();
    const pending = runWorkflow({ cwd, signal: controller.signal });
    for (let index = 0; index < 200; index += 1) {
      if (await readFile(path.join(cwd, ".ariadne", "control", "marker"), "utf8").catch(() => undefined)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort("test");
    const batch = await pending;
    expect(batch.batchStatus).toBe("interrupted");
    expect(batch.tasks[0].state).toBe("interrupted");
    expect(batch.tasks[0].attempts).toHaveLength(1);
    expect(batch.lifecycle.some((event) => event.stage === "cancelling")).toBe(true);
  });

  it("interrupts active parallel tasks and launches nothing new", async () => {
    const cwd = await fixture([{ id: "a", parallelSafe: true }, { id: "b", parallelSafe: true }, { id: "c", parallelSafe: true }], { a: { delay: 5000 }, b: { delay: 5000 }, c: {} }, { concurrency: 2 });
    const controller = new AbortController();
    const pending = runWorkflow({ cwd, signal: controller.signal });
    for (let index = 0; index < 300; index += 1) {
      const current = await events(cwd).catch(() => []);
      if (current.filter((event) => event.kind === "start").length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    controller.abort("test");
    const batch = await pending;
    expect(batch.batchStatus).toBe("interrupted");
    expect(batch.tasks.filter((task) => task.state === "interrupted")).toHaveLength(2);
    expect(batch.tasks.find((task) => task.id === "c")?.state).toBe("skipped");
    expect((await events(cwd)).filter((event) => event.kind === "start").map((event) => event.id).sort()).toEqual(["a", "b"]);
  });
});
