import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { runWorkflow } from "../src/core/workflow-runner.js";
import { resumeWorkflow } from "../src/core/workflow-control.js";
import { applyResult, discardResult, promotionStatus } from "../src/core/promotion.js";
import { exitCodeForBatch } from "../src/commands/run.js";
import { cleanupTempDirs, initGit, tempDir } from "./helpers.js";

afterEach(cleanupTempDirs);

async function fixture(options: { preparation?: string; retention?: "always" | "on-failure" | "never" } = {}): Promise<string> {
  const cwd = await tempDir("ariadne-isolation-");
  await mkdir(path.join(cwd, ".ariadne", "tasks"), { recursive: true });
  await writeFile(path.join(cwd, ".gitignore"), ".ariadne/runs/\n.ariadne/batches/\n.ariadne/worktrees/\n.ariadne/promotions/\n.ariadne/latest.json\nnode_modules/\n");
  await writeFile(path.join(cwd, "target.txt"), "before\n");
  await writeFile(path.join(cwd, "agent.mjs"), `import { appendFile } from "node:fs/promises"; await appendFile("target.txt", "isolated\\n");`);
  await writeFile(path.join(cwd, "ariadne.yml"), `version: 4
agent:
  command: {kind: exec, file: node, args: [agent.mjs]}
  timeout_ms: 2000
tasks: {directory: .ariadne/tasks}
verification: {commands: [], timeout_ms: 1000}
execution:
  termination_grace_ms: 100
  concurrency: 2
  failure_mode: continue
  isolation: worktree
  worktree:
    retention: ${options.retention ?? "never"}
    preparation:
      commands: ${options.preparation ?? "[]"}
      timeout_ms: 1000
checks: {forbidden_files: [.env], forbidden_commands: []}
`);
  await writeFile(path.join(cwd, ".ariadne", "tasks", "edit.yml"), `id: edit
workspaceMode: mutable
prompt: edit
`);
  await initGit(cwd, {});
  return cwd;
}

describe("isolated worktrees and promotion", () => {
  it("keeps the primary checkout unchanged, captures a durable result, and applies it transactionally", async () => {
    const cwd = await fixture();
    await mkdir(path.join(cwd, "node_modules", "fixture"), { recursive: true });
    await writeFile(path.join(cwd, "node_modules", "fixture", "index.js"), "ignored dependency\n");
    const beforeHead = (await execa("git", ["rev-parse", "HEAD"], { cwd })).stdout;
    const batch = await runWorkflow({ cwd });
    expect(batch.batchStatus, JSON.stringify({ failures: batch.failures, tasks: batch.tasks }, null, 2)).toBe("succeeded");
    expect(await readFile(path.join(cwd, "target.txt"), "utf8")).toBe("before\n");
    const attempt = batch.tasks[0].attempts[0];
    expect(attempt).toMatchObject({ outcome: "passed", applicable: true, workspaceId: expect.stringMatching(/^ws-/), resultRevision: expect.any(String) });
    expect((await execa("git", ["rev-parse", "HEAD"], { cwd })).stdout).toBe(beforeHead);
    await expect(execa("git", ["cat-file", "-e", `${attempt.resultRevision}^{commit}`], { cwd })).resolves.toBeDefined();

    const promotion = await applyResult(cwd, attempt.runId);
    expect(promotion).toMatchObject({ status: "succeeded", includedRunIds: [attempt.runId], strategy: "preflight-squash-cherry-pick" });
    expect(await readFile(path.join(cwd, "target.txt"), "utf8")).toBe("before\nisolated\n");
    expect((await promotionStatus(cwd, attempt.runId)).promotion).toBe("applied");
    await expect(applyResult(cwd, attempt.runId)).rejects.toMatchObject({ code: "RESULT_ALREADY_APPLIED" });
  });

  it("records a preflight conflict without changing the primary checkout", async () => {
    const cwd = await fixture();
    const batch = await runWorkflow({ cwd });
    const attempt = batch.tasks[0].attempts[0];
    await writeFile(path.join(cwd, "target.txt"), "primary advance\n");
    await execa("git", ["add", "target.txt"], { cwd });
    await execa("git", ["-c", "user.name=Ariadne Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "advance"], { cwd });
    const advancedHead = (await execa("git", ["rev-parse", "HEAD"], { cwd })).stdout;
    const promotion = await applyResult(cwd, attempt.runId);
    expect(promotion.status).toBe("conflicted");
    expect(await readFile(path.join(cwd, "target.txt"), "utf8")).toBe("primary advance\n");
    expect((await execa("git", ["rev-parse", "HEAD"], { cwd })).stdout).toBe(advancedHead);
  });

  it("discards an unapplied result ref while preserving the run manifest", async () => {
    const cwd = await fixture({ retention: "always" });
    const batch = await runWorkflow({ cwd });
    const attempt = batch.tasks[0].attempts[0];
    const promotion = await discardResult(cwd, attempt.runId);
    expect(promotion.status).toBe("discarded");
    const ref = await execa("git", ["show-ref", "--verify", `refs/ariadne/results/${attempt.runId}`], { cwd, reject: false });
    expect(ref.exitCode).not.toBe(0);
    expect(await readFile(path.join(cwd, attempt.manifest), "utf8")).toContain(attempt.runId);
  });

  it("classifies preparation failure before launching the agent", async () => {
    const cwd = await fixture({ preparation: "[{kind: exec, file: node, args: [-e, 'process.exit(9)']}]", retention: "on-failure" });
    const batch = await runWorkflow({ cwd });
    expect(batch.tasks[0].attempts[0]).toMatchObject({ outcome: "preparation_failed", retryEligible: false });
    expect(batch).toMatchObject({ status: "failed", batchStatus: "failed", outcome: "preparation_failed", summary: { outcome: "preparation_failed" } });
    expect(exitCodeForBatch(batch)).toBe(14);
    expect(await readFile(path.join(cwd, "target.txt"), "utf8")).toBe("before\n");
  });

  it("layers successful dependency results and promotes the closure in plan order", async () => {
    const cwd = await fixture();
    await writeFile(path.join(cwd, "agent.mjs"), `
import { readFile, writeFile } from "node:fs/promises";
const id = process.env.ARIADNE_TASK_ID;
if (id === "dependency") await writeFile("dependency.txt", "dependency result\\n");
if (id === "consumer") {
  const inherited = await readFile("dependency.txt", "utf8");
  await writeFile("consumer.txt", inherited + "consumer result\\n");
}
`);
    await writeFile(path.join(cwd, ".ariadne", "tasks", "edit.yml"), `id: dependency\nworkspaceMode: mutable\nprompt: dependency\n`);
    await writeFile(path.join(cwd, ".ariadne", "tasks", "consumer.yml"), `id: consumer\ndependsOn: [dependency]\nworkspaceMode: mutable\nprompt: consumer\n`);
    await execa("git", ["add", "."], { cwd });
    await execa("git", ["-c", "user.name=Ariadne Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "dependency fixture"], { cwd });
    const batch = await runWorkflow({ cwd });
    expect(batch.batchStatus).toBe("succeeded");
    const dependency = batch.tasks.find((task) => task.id === "dependency")!.attempts[0];
    const consumer = batch.tasks.find((task) => task.id === "consumer")!.attempts[0];
    const consumerRecord = JSON.parse(await readFile(path.join(cwd, consumer.manifest), "utf8"));
    expect(consumerRecord.workspace.inheritedResults).toEqual([{ taskId: "dependency", runId: dependency.runId, resultRevision: dependency.resultRevision }]);
    expect(await readFile(path.join(cwd, "dependency.txt"), "utf8").catch(() => undefined)).toBeUndefined();
    const promotion = await applyResult(cwd, consumer.runId);
    expect(promotion.includedRunIds).toEqual([dependency.runId, consumer.runId]);
    expect(await readFile(path.join(cwd, "dependency.txt"), "utf8")).toBe("dependency result\n");
    expect(await readFile(path.join(cwd, "consumer.txt"), "utf8")).toContain("consumer result");
  });

  it("runs mutable tasks in distinct concurrent worktrees", async () => {
    const cwd = await fixture();
    await writeFile(path.join(cwd, "agent.mjs"), `import { writeFile } from "node:fs/promises"; await new Promise((resolve) => setTimeout(resolve, 100)); await writeFile(process.env.ARIADNE_TASK_ID + ".txt", "isolated\\n");`);
    await writeFile(path.join(cwd, ".ariadne", "tasks", "edit.yml"), `id: first\nworkspaceMode: mutable\nprompt: first\n`);
    await writeFile(path.join(cwd, ".ariadne", "tasks", "second.yml"), `id: second\nworkspaceMode: mutable\nprompt: second\n`);
    await execa("git", ["add", "."], { cwd });
    await execa("git", ["-c", "user.name=Ariadne Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "parallel fixture"], { cwd });
    const batch = await runWorkflow({ cwd, concurrency: 2 });
    expect(batch.batchStatus).toBe("succeeded");
    expect(new Set(batch.tasks.map((task) => task.attempts[0].workspaceId)).size).toBe(2);
    expect(batch.tasks.every((task) => task.attempts[0].applicable)).toBe(true);
    expect(await readFile(path.join(cwd, "first.txt"), "utf8").catch(() => undefined)).toBeUndefined();
    expect(await readFile(path.join(cwd, "second.txt"), "utf8").catch(() => undefined)).toBeUndefined();
  });

  it("fails Git-visible mutation from a read-only task", async () => {
    const cwd = await fixture({ retention: "on-failure" });
    await writeFile(path.join(cwd, ".ariadne", "tasks", "edit.yml"), `id: edit\nworkspaceMode: read-only\nprompt: edit\n`);
    await execa("git", ["add", "."], { cwd });
    await execa("git", ["-c", "user.name=Ariadne Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "read-only fixture"], { cwd });
    const batch = await runWorkflow({ cwd });
    expect(batch.tasks[0].attempts[0]).toMatchObject({ outcome: "policy_failed", applicable: false });
    const record = JSON.parse(await readFile(path.join(cwd, batch.tasks[0].attempts[0].manifest), "utf8"));
    expect(record.results[0].policies).toContainEqual(expect.objectContaining({ ruleId: "workspace.read-only", outcome: "fail" }));
    expect(record.workspace.state).toBe("retained");
  });

  it("omits ignored forbidden files from commits and patches", async () => {
    const cwd = await fixture({ retention: "on-failure" });
    await writeFile(path.join(cwd, "agent.mjs"), `import { writeFile } from "node:fs/promises"; import { execFileSync } from "node:child_process"; await writeFile(".env", "TOP_SECRET=value\\n"); await writeFile("safe.txt", "safe\\n"); execFileSync("git", ["add", "-A"]); execFileSync("git", ["add", "-f", ".env"]);`);
    await execa("git", ["add", "agent.mjs"], { cwd });
    await execa("git", ["-c", "user.name=Ariadne Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "forbidden fixture"], { cwd });
    const batch = await runWorkflow({ cwd });
    const attempt = batch.tasks[0].attempts[0];
    const record = JSON.parse(await readFile(path.join(cwd, attempt.manifest), "utf8"));
    expect(record.changeArtifact).toMatchObject({
      applicable: false,
      changes: [expect.objectContaining({ path: "safe.txt", kind: "file", mode: expect.any(String) })],
      omittedSensitive: [expect.objectContaining({ path: ".env", reason: "configured-forbidden-file" })]
    });
    const patch = await readFile(path.join(cwd, record.changeArtifact.patchArtifact), "utf8");
    expect(patch).toContain("safe.txt");
    expect(patch).not.toContain("TOP_SECRET");
    expect(await readFile(path.join(cwd, record.changeArtifact.manifestArtifact), "utf8")).not.toContain("TOP_SECRET=value");
  });

  it("rejects a dirty primary base unless explicitly acknowledged and records excluded dirt", async () => {
    const cwd = await fixture();
    await writeFile(path.join(cwd, "target.txt"), "uncommitted primary dirt\n");
    const rejected = await runWorkflow({ cwd });
    expect(rejected.failures).toContainEqual(expect.objectContaining({ code: "DIRTY_WORKTREE_BASE" }));
    expect(rejected.tasks).toHaveLength(0);
    const acknowledged = await runWorkflow({ cwd, allowDirtyBase: true });
    expect(acknowledged.batchStatus).toBe("succeeded_with_warnings");
    expect(acknowledged.excludedSourceChanges).toContainEqual(expect.objectContaining({ path: "target.txt" }));
    expect(await readFile(path.join(cwd, "target.txt"), "utf8")).toBe("uncommitted primary dirt\n");
    const record = JSON.parse(await readFile(path.join(cwd, acknowledged.tasks[0].attempts[0].manifest), "utf8"));
    expect(record.workspace).toMatchObject({ dirtyBaseAcknowledged: true, sourceDirty: true, excludedSourceChanges: [expect.objectContaining({ path: "target.txt" })] });
  });

  it("attributes successful preparation changes separately", async () => {
    const cwd = await fixture({ preparation: "[{kind: exec, file: node, args: [-e, \"require('node:fs').writeFileSync('prepared.txt','prepared')\"]}]" });
    const batch = await runWorkflow({ cwd });
    const record = JSON.parse(await readFile(path.join(cwd, batch.tasks[0].attempts[0].manifest), "utf8"));
    expect(record.results[0].trace.preparationChanges).toContainEqual(expect.objectContaining({ path: "prepared.txt", source: "preparation" }));
    expect(record.workspace.preparation).toHaveLength(1);
    expect(record.changeArtifact.changes.map((change: { path: string }) => change.path)).toEqual(["prepared.txt", "target.txt"]);
  });

  it("persists timed-out isolated attempts and retains their workspace", async () => {
    const cwd = await fixture({ retention: "on-failure" });
    const configPath = path.join(cwd, "ariadne.yml");
    const config = await readFile(configPath, "utf8");
    await writeFile(configPath, config.replace("timeout_ms: 2000", "timeout_ms: 50"));
    await writeFile(path.join(cwd, "agent.mjs"), `setInterval(() => {}, 1000);`);
    await execa("git", ["add", "."], { cwd });
    await execa("git", ["-c", "user.name=Ariadne Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "timeout fixture"], { cwd });
    const batch = await runWorkflow({ cwd });
    const attempt = batch.tasks[0].attempts[0];
    expect(attempt.outcome).toBe("timeout");
    const record = JSON.parse(await readFile(path.join(cwd, attempt.manifest), "utf8"));
    expect(record).toMatchObject({ status: "failed", summary: { outcome: "timeout" }, workspace: { state: "retained" } });
    expect(record.results[0].agent).toMatchObject({ timedOut: true, cleanup: { attempted: true } });
  });

  it("resumes a retry-eligible isolated failure in a fresh workspace with increasing attempt numbers", async () => {
    const cwd = await fixture({ retention: "on-failure" });
    const externalMarker = path.join(await tempDir("ariadne-external-state-"), "resume-marker");
    await writeFile(path.join(cwd, "agent.mjs"), `
import { access, writeFile } from "node:fs/promises";
const marker = ${JSON.stringify(externalMarker)};
const exists = await access(marker).then(() => true, () => false);
if (!exists) { await writeFile(marker, "failed once"); process.exit(7); }
`);
    await execa("git", ["add", "agent.mjs"], { cwd });
    await execa("git", ["-c", "user.name=Ariadne Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "resume fixture"], { cwd });
    const source = await runWorkflow({ cwd });
    expect(source.tasks[0].attempts[0]).toMatchObject({ outcome: "agent_failed", retryEligible: true });
    const resumed = await resumeWorkflow({ cwd, batchId: source.batchId });
    expect(resumed.tasks[0].state).toBe("succeeded");
    expect(resumed.tasks[0].attempts.map((attempt) => attempt.attempt)).toEqual([1, 2]);
    expect(new Set(resumed.tasks[0].attempts.map((attempt) => attempt.workspaceId)).size).toBe(2);
  });
});
