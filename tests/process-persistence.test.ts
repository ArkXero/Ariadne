import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createRunPaths } from "../src/core/persistence.js";
import { runProcess } from "../src/core/process-runner.js";
import { formatRunCompletion } from "../src/core/report.js";
import { runAriadne } from "../src/core/runner.js";
import { cleanupTempDirs, initGit, tempDir, writeProject } from "./helpers.js";

afterEach(cleanupTempDirs);

describe("process runner", () => {
  it("streams stdout and stderr to artifacts with structured metadata", async () => {
    const cwd = await tempDir();
    const result = await runProcess({
      spec: { kind: "exec", file: "node", args: ["-e", "process.stdout.write('out'); process.stderr.write('err')"] },
      projectRoot: cwd,
      stdoutPath: path.join(cwd, "artifacts", "out.log"),
      stderrPath: path.join(cwd, "artifacts", "err.log"),
      timeoutMs: 1_000,
      terminationGraceMs: 100
    });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, interrupted: false, spawnError: undefined });
    expect(await readFile(path.join(cwd, "artifacts", "out.log"), "utf8")).toBe("out");
    expect(await readFile(path.join(cwd, "artifacts", "err.log"), "utf8")).toBe("err");
  });

  it("separates spawn failure from nonzero exit", async () => {
    const cwd = await tempDir();
    const failed = await runProcess({
      spec: { kind: "exec", file: "ariadne-executable-that-does-not-exist", args: [] },
      projectRoot: cwd,
      stdoutPath: path.join(cwd, "out"), stderrPath: path.join(cwd, "err"),
      timeoutMs: 1_000, terminationGraceMs: 100
    });
    expect(failed.exitCode).toBeNull();
    expect(failed.spawnError).toBeTruthy();
    const nonzero = await runProcess({
      spec: { kind: "exec", file: "node", args: ["-e", "process.exit(7)"] },
      projectRoot: cwd,
      stdoutPath: path.join(cwd, "out2"), stderrPath: path.join(cwd, "err2"),
      timeoutMs: 1_000, terminationGraceMs: 100
    });
    expect(nonzero).toMatchObject({ exitCode: 7, spawnError: undefined });
  });

  it("bounds previews while preserving complete large output", async () => {
    const cwd = await tempDir();
    const outputPath = path.join(cwd, "large.log");
    const result = await runProcess({
      spec: { kind: "exec", file: "node", args: ["-e", "process.stdout.write('x'.repeat(200000))"] },
      projectRoot: cwd,
      stdoutPath: outputPath, stderrPath: path.join(cwd, "err"),
      timeoutMs: 2_000, terminationGraceMs: 100
    });
    expect(result.stdoutPreview.bytes).toBe(200_000);
    expect(Buffer.byteLength(result.stdoutPreview.head)).toBeLessThanOrEqual(4_096);
    expect(Buffer.byteLength(result.stdoutPreview.tail)).toBeLessThanOrEqual(12_288);
    expect((await readFile(outputPath)).length).toBe(200_000);
  });

  it("records invalid UTF-8 replacement without losing raw bytes", async () => {
    const cwd = await tempDir();
    const outputPath = path.join(cwd, "invalid.log");
    const result = await runProcess({
      spec: { kind: "exec", file: "node", args: ["-e", "process.stdout.write(Buffer.from([0xff, 0xfe, 0x61]))"] },
      projectRoot: cwd,
      stdoutPath: outputPath, stderrPath: path.join(cwd, "err"),
      timeoutMs: 1_000, terminationGraceMs: 100
    });
    expect(result.stdoutPreview).toMatchObject({ bytes: 3, hadDecodingReplacement: true });
    expect(await readFile(outputPath)).toEqual(Buffer.from([0xff, 0xfe, 0x61]));
  });

  it("distinguishes timeout and interruption and attempts cleanup", async () => {
    const cwd = await tempDir();
    const timeout = await runProcess({
      spec: { kind: "exec", file: "node", args: ["-e", "setInterval(() => {}, 1000)"] },
      projectRoot: cwd,
      stdoutPath: path.join(cwd, "to.out"), stderrPath: path.join(cwd, "to.err"),
      timeoutMs: 30, terminationGraceMs: 100
    });
    expect(timeout).toMatchObject({ timedOut: true, interrupted: false, cleanup: { attempted: true } });

    const controller = new AbortController();
    setTimeout(() => controller.abort("test"), 30);
    const interrupted = await runProcess({
      spec: { kind: "exec", file: "node", args: ["-e", "setInterval(() => {}, 1000)"] },
      projectRoot: cwd,
      stdoutPath: path.join(cwd, "int.out"), stderrPath: path.join(cwd, "int.err"),
      timeoutMs: 2_000, terminationGraceMs: 100, signal: controller.signal
    });
    expect(interrupted).toMatchObject({ timedOut: false, interrupted: true, cleanup: { attempted: true } });
  });

  it.skipIf(process.platform === "win32")("does not report cleanup success while a process-group descendant survives", async () => {
    const cwd = await tempDir();
    const pidPath = path.join(cwd, "descendant.pid");
    const result = await runProcess({
      spec: {
        kind: "exec",
        file: "node",
        args: [
          "-e",
          [
            "const { spawn } = require('node:child_process')",
            "const fs = require('node:fs')",
            "const child = spawn(process.execPath, ['-e', `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`], { stdio: 'ignore' })",
            "fs.writeFileSync('descendant.pid', String(child.pid))",
            "setInterval(() => {}, 1000)"
          ].join(";")
        ]
      },
      projectRoot: cwd,
      stdoutPath: path.join(cwd, "tree.out"),
      stderrPath: path.join(cwd, "tree.err"),
      timeoutMs: 100,
      terminationGraceMs: 100
    });
    const descendantPid = Number(await readFile(pidPath, "utf8"));
    const descendantAlive = (): boolean => {
      try {
        process.kill(descendantPid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(result).toMatchObject({
      timedOut: true,
      cleanup: { attempted: true, gracefulSucceeded: false, forceSignal: "SIGKILL", forceSucceeded: true }
    });
    expect(descendantAlive()).toBe(false);
  });
});

describe("run lifecycle and persistence", () => {
  it("writes a v2 per-run manifest, latest pointer, and hashed prompt", async () => {
    const cwd = await tempDir();
    await writeProject(cwd, { tasks: [{ id: "safe", prompt: "TOP SECRET PROMPT" }] });
    const run = await runAriadne({ cwd, now: () => new Date("2026-01-01T00:00:00.000Z"), randomId: () => "01234567-89ab-cdef-0123-456789abcdef" });
    expect(run.runId).toBe("20260101T000000000Z-0123456789");
    expect(run.summary).toMatchObject({ status: "completed", outcome: "passed", total: 1 });
    const raw = await readFile(run.outputPath, "utf8");
    expect(raw).not.toContain("TOP SECRET PROMPT");
    expect(JSON.parse(raw).results[0].task).toMatchObject({ promptLength: 17, promptSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.parse(await readFile(path.join(cwd, ".ariadne", "runs", "latest.json"), "utf8"))).toMatchObject({ runId: run.runId, manifest: `${run.runId}/run.json` });
  });

  it("redacts secret-bearing command arguments in persisted records", async () => {
    const cwd = await tempDir();
    await writeProject(cwd, { agentArgs: ["-e", "process.stdin.resume()", "--", "--api-key", "super-secret-value"] });
    const run = await runAriadne({ cwd });
    const raw = await readFile(run.outputPath, "utf8");
    expect(raw).not.toContain("super-secret-value");
    expect(raw).toContain("[REDACTED]");
  });

  it("persists structured configuration failure instead of losing the run", async () => {
    const cwd = await tempDir();
    const run = await runAriadne({ cwd });
    expect(run.status).toBe("failed");
    expect(run.failures[0]).toMatchObject({ category: "configuration", code: "CONFIG_NOT_FOUND", source: "ariadne.yml" });
    expect(JSON.parse(await readFile(run.outputPath, "utf8")).failures[0]).toMatchObject({ category: "configuration", source: "ariadne.yml" });
    expect(formatRunCompletion(run)).toContain("Source: ariadne.yml");
  });

  it("continues serial tasks after an agent failure and isolates results", async () => {
    const cwd = await tempDir();
    await writeProject(cwd, {
      agentArgs: ["-e", "process.stdin.resume(); process.exitCode = process.env.ARIADNE_TASK_ID === 'bad' ? 9 : 0"],
      tasks: [{ id: "bad" }, { id: "good" }]
    });
    const run = await runAriadne({ cwd });
    expect(run.results.map((result) => result.outcome)).toEqual(["agent_failed", "passed"]);
    expect(run.summary).toMatchObject({ total: 2, passed: 1, failed: 1, outcome: "agent_failed" });
  });

  it("runs verification after agent nonzero but skips it after spawn failure", async () => {
    const nonzero = await tempDir();
    await writeProject(nonzero, { agentArgs: ["-e", "process.exit(7)"] });
    let source = await readFile(path.join(nonzero, "ariadne.yml"), "utf8");
    await writeFile(path.join(nonzero, "ariadne.yml"), source.replace("  commands: []", "  commands:\n    - kind: exec\n      file: node\n      args: [\"-e\", \"process.exit(0)\"]"));
    const nonzeroRun = await runAriadne({ cwd: nonzero });
    expect(nonzeroRun.results[0]).toMatchObject({ outcome: "agent_failed", verification: [{ status: "passed" }] });

    const spawnFailure = await tempDir();
    await writeProject(spawnFailure);
    source = await readFile(path.join(spawnFailure, "ariadne.yml"), "utf8");
    await writeFile(path.join(spawnFailure, "ariadne.yml"), source
      .replace("file: node", "file: definitely-not-an-ariadne-executable")
      .replace("  commands: []", "  commands:\n    - kind: exec\n      file: node\n      args: [\"-e\", \"process.exit(0)\"]"));
    const spawnRun = await runAriadne({ cwd: spawnFailure });
    expect(spawnRun.results[0]).toMatchObject({ outcome: "agent_failed", verification: [{ status: "skipped", skipReason: expect.stringContaining("could not be spawned") }] });
    expect(formatRunCompletion(spawnRun)).toContain("verification: skipped");
    expect(formatRunCompletion(spawnRun)).not.toContain("verification: failed");
  });

  it("records a single verification-stage interruption failure", async () => {
    const cwd = await tempDir();
    await writeProject(cwd);
    const config = await readFile(path.join(cwd, "ariadne.yml"), "utf8");
    await writeFile(path.join(cwd, "ariadne.yml"), config.replace(
      "  commands: []",
      "  commands:\n    - kind: exec\n      file: node\n      args: [\"-e\", \"require('fs').writeFileSync('verification-started', 'yes'); setInterval(() => {}, 1000)\"]"
    ));
    const controller = new AbortController();
    const runPromise = runAriadne({ cwd, signal: controller.signal });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await readFile(path.join(cwd, "verification-started"), "utf8").catch(() => undefined)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    controller.abort("test");
    const run = await runPromise;
    expect(run.summary.outcome).toBe("interrupted");
    expect(run.results[0].failures).toEqual([expect.objectContaining({ code: "RUN_INTERRUPTED", stage: "verifying" })]);
    expect(run.results[0].failures.some((item) => item.code === "VERIFICATION_NONZERO")).toBe(false);
  });

  it("blocks a directly forbidden command before it can launch", async () => {
    const cwd = await tempDir();
    await writeProject(cwd, {
      agentArgs: ["-e", "require('fs').writeFileSync('should-not-exist', 'bad')"],
      checks: "  forbidden_files: []\n  forbidden_commands: [\"node -e\"]"
    });
    const run = await runAriadne({ cwd });
    expect(run.results[0]).toMatchObject({ outcome: "policy_failed", score: { value: 70 } });
    await expect(readFile(path.join(cwd, "should-not-exist"))).rejects.toThrow();
  });

  it("does not count unchanged preexisting dirt but counts further edits", async () => {
    const cwd = await tempDir();
    await initGit(cwd);
    await writeFile(path.join(cwd, "README.md"), "preexisting\n");
    await writeProject(cwd, { agentArgs: ["-e", "require('fs').appendFileSync('README.md', 'agent\\n'); process.stdin.resume()"] });
    const run = await runAriadne({ cwd });
    expect(run.results[0].trace?.preexistingChanges.map((entry) => entry.path)).toContain("README.md");
    expect(run.results[0].trace?.taskChanges.map((entry) => entry.path)).toEqual(["README.md"]);
    expect(run.results[0].trace?.diffLineCount).toBeGreaterThan(0);
  });

  it("scopes Git attribution to a nested invocation root", async () => {
    const root = await tempDir();
    const cwd = path.join(root, "nested", "project");
    await writeProject(cwd, { agentArgs: ["-e", "require('fs').appendFileSync('target.txt', 'agent\\n'); process.stdin.resume()"] });
    await initGit(root, { "nested/project/target.txt": "original\n", "outside.txt": "outside\n" });
    await writeFile(path.join(root, "outside.txt"), "unrelated parent dirt\n");
    const run = await runAriadne({ cwd });
    expect(run.results[0].trace?.preexistingChanges).toEqual([]);
    expect(run.results[0].trace?.taskChanges).toEqual([
      expect.objectContaining({ path: "target.txt", changeType: "modified", source: "agent" })
    ]);
    expect(run.results[0].trace?.diffLineCount).toBeGreaterThan(0);
  });

  it("attributes an unstaged content-preserving move as one zero-line rename", async () => {
    const cwd = await tempDir();
    await writeProject(cwd, { agentArgs: ["-e", "require('fs').renameSync('old.txt', 'new.txt'); process.stdin.resume()"] });
    await initGit(cwd, { "old.txt": "same contents\n" });
    const run = await runAriadne({ cwd });
    expect(run.results[0].trace?.taskChanges).toEqual([
      expect.objectContaining({ path: "new.txt", originalPath: "old.txt", changeType: "renamed", source: "agent" })
    ]);
    expect(run.results[0].trace?.diffLineCount).toBe(0);
  });

  it("classifies removal of a preexisting untracked path as deleted", async () => {
    const cwd = await tempDir();
    await writeProject(cwd, { agentArgs: ["-e", "require('fs').unlinkSync('temporary.txt'); process.stdin.resume()"] });
    await initGit(cwd);
    await writeFile(path.join(cwd, "temporary.txt"), "temporary\n");
    const run = await runAriadne({ cwd });
    expect(run.results[0].trace?.taskChanges).toEqual([
      expect.objectContaining({ path: "temporary.txt", changeType: "deleted", source: "agent" })
    ]);
  });

  it("refuses run-directory collisions", async () => {
    const cwd = await tempDir();
    await createRunPaths(cwd, "same");
    await expect(createRunPaths(cwd, "same")).rejects.toThrow("already exists");
  });
});
