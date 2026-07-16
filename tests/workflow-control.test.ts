import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execa } from "execa";
import { resumeWorkflow, rerunWorkflow } from "../src/core/workflow-control.js";
import { runWorkflow } from "../src/core/workflow-runner.js";
import { cleanupTempDirs, initGit, tempDir } from "./helpers.js";

afterEach(cleanupTempDirs);

async function project(): Promise<string> {
  const cwd = await tempDir("ariadne-control-");
  await mkdir(path.join(cwd, ".ariadne", "tasks"), { recursive: true });
  await writeFile(path.join(cwd, ".gitignore"), ".ariadne/runs/\n.ariadne/batches/\n.ariadne/control/\n");
  await writeFile(path.join(cwd, "behavior.json"), JSON.stringify({ a: "fail", b: "pass" }));
  await writeFile(path.join(cwd, "agent.mjs"), `import { readFile } from "node:fs/promises"; const behavior=JSON.parse(await readFile("behavior.json","utf8")); if(behavior[process.env.ARIADNE_TASK_ID]==="fail") process.exit(7);`);
  await writeFile(path.join(cwd, "ariadne.yml"), `version: 4
agent: {command: {kind: exec, file: node, args: [agent.mjs]}, timeout_ms: 1000}
tasks: {directory: .ariadne/tasks}
verification: {commands: [], timeout_ms: 1000}
execution: {termination_grace_ms: 100, concurrency: 1, failure_mode: continue}
checks: {forbidden_files: [], forbidden_commands: []}
`);
  await writeFile(path.join(cwd, ".ariadne", "tasks", "a.yml"), `id: a\nprompt: a\nretry: {attempts: 1, delayMs: 0, backoff: fixed}\n`);
  await writeFile(path.join(cwd, ".ariadne", "tasks", "b.yml"), `id: b\nprompt: b\n`);
  await initGit(cwd, {});
  return cwd;
}

describe("workflow resume and rerun", () => {
  it("resumes retry-eligible failures without rerunning successful tasks", async () => {
    const cwd = await project();
    const source = await runWorkflow({ cwd });
    await writeFile(path.join(cwd, "behavior.json"), JSON.stringify({ a: "pass", b: "pass" }));
    const config = await readFile(path.join(cwd, "ariadne.yml"), "utf8");
    await writeFile(path.join(cwd, "ariadne.yml"), config.replace("concurrency: 1", "concurrency: 2"));
    const resumed = await resumeWorkflow({ cwd, batchId: source.batchId, concurrency: 2 });
    expect(resumed.relation).toEqual({ kind: "resume", sourceBatchId: source.batchId });
    expect(resumed.batchStatus).toBe("succeeded_with_warnings");
    expect(resumed.tasks.find((task) => task.id === "a")?.attempts.map((attempt) => attempt.attempt)).toEqual([1, 2]);
    expect(resumed.tasks.find((task) => task.id === "b")?.attempts).toHaveLength(1);
    expect(resumed.tasks.find((task) => task.id === "b")?.attempts[0].runId).toBe(source.tasks.find((task) => task.id === "b")?.attempts[0].runId);
    expect(resumed.plan?.concurrency).toBe(2);
  });

  it("rejects semantic configuration drift and changed Git HEAD", async () => {
    const cwd = await project();
    const source = await runWorkflow({ cwd });
    await writeFile(path.join(cwd, ".ariadne", "tasks", "a.yml"), `id: a\nprompt: changed\n`);
    await expect(resumeWorkflow({ cwd, batchId: source.batchId })).rejects.toMatchObject({ code: "RESUME_CONFIG_CHANGED" });
    await writeFile(path.join(cwd, ".ariadne", "tasks", "a.yml"), `id: a\nprompt: a\nretry: {attempts: 1, delayMs: 0, backoff: fixed}\n`);
    const originalConfig = await readFile(path.join(cwd, "ariadne.yml"), "utf8");
    await writeFile(path.join(cwd, "ariadne.yml"), originalConfig.replace("failure_mode: continue", "failure_mode: fail-fast"));
    await expect(resumeWorkflow({ cwd, batchId: source.batchId })).rejects.toMatchObject({ code: "RESUME_CONFIG_CHANGED" });
    await writeFile(path.join(cwd, "ariadne.yml"), originalConfig);
    await writeFile(path.join(cwd, "new.txt"), "commit\n");
    await execa("git", ["add", "."], { cwd });
    await execa("git", ["-c", "user.name=Ariadne Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "new head"], { cwd });
    await expect(resumeWorkflow({ cwd, batchId: source.batchId })).rejects.toMatchObject({ code: "RESUME_HEAD_CHANGED" });
  });

  it("requeues a missing successful child when another branch is resumable", async () => {
    const cwd = await project();
    const source = await runWorkflow({ cwd });
    const successful = source.tasks.find((task) => task.id === "b")!.attempts[0];
    await rm(path.join(cwd, successful.manifest));
    await writeFile(path.join(cwd, "behavior.json"), JSON.stringify({ a: "pass", b: "pass" }));
    const resumed = await resumeWorkflow({ cwd, batchId: source.batchId });
    expect(resumed.tasks.find((task) => task.id === "b")?.attempts).toHaveLength(2);
    expect(resumed.tasks.find((task) => task.id === "b")?.warnings.join(" ")).toContain("missing");
  });

  it("reruns failed selections as a new batch with current configuration", async () => {
    const cwd = await project();
    const source = await runWorkflow({ cwd });
    await writeFile(path.join(cwd, "behavior.json"), JSON.stringify({ a: "pass", b: "pass" }));
    const rerun = await rerunWorkflow({ cwd, batchId: source.batchId, mode: "failed" });
    expect(rerun.relation).toEqual({ kind: "rerun", sourceBatchId: source.batchId });
    expect(rerun.plan?.selectedRoots).toEqual(["a"]);
    expect(rerun.tasks.map((task) => task.id)).toEqual(["a"]);
    expect(rerun.batchStatus).toBe("succeeded");
  });

  it("rejects resume of a successful batch and empty rerun selections", async () => {
    const cwd = await project();
    await writeFile(path.join(cwd, "behavior.json"), JSON.stringify({ a: "pass", b: "pass" }));
    const source = await runWorkflow({ cwd });
    await expect(resumeWorkflow({ cwd, batchId: source.batchId })).rejects.toMatchObject({ code: "BATCH_ALREADY_SUCCEEDED" });
    await expect(rerunWorkflow({ cwd, batchId: source.batchId, mode: "failed" })).rejects.toMatchObject({ code: "RERUN_SELECTION_EMPTY" });
  });
});
