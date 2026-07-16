import path from "node:path";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { initCommand } from "../src/commands/init.js";
import { loadConfig } from "../src/core/config.js";
import { diagnoseRepository } from "../src/core/doctor.js";
import { loadTasks } from "../src/core/task-loader.js";
import { cleanupTempDirs, tempDir, writeProject } from "./helpers.js";

afterEach(cleanupTempDirs);

describe("configuration contracts", () => {
  it("loads strict v4 isolation, retention, preparation, and workspace-mode fields", async () => {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, ".ariadne", "tasks"), { recursive: true });
    await writeFile(path.join(cwd, "ariadne.yml"), `version: 4
agent: {command: {kind: exec, file: node, args: []}}
execution:
  isolation: worktree
  worktree:
    retention: always
    preparation:
      commands: [{kind: exec, file: node, args: [-v]}]
      timeout_ms: 1234
`);
    await writeFile(path.join(cwd, ".ariadne", "tasks", "read.yml"), `id: read\nworkspaceMode: read-only\nprompt: inspect\n`);
    const loaded = await loadConfig(cwd);
    const tasks = await loadTasks(cwd, loaded.config.tasks.directory, loaded.config.sourceVersion);
    expect(loaded.config.execution).toMatchObject({ isolation: "worktree", worktree: { retention: "always", preparation: { timeout_ms: 1234 } } });
    expect(tasks[0]).toMatchObject({ workspaceMode: "read-only" });
  });

  it("adapts strict v2 config to v4 workflow defaults", async () => {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, ".ariadne", "tasks"), { recursive: true });
    await writeFile(path.join(cwd, "ariadne.yml"), "version: 2\nagent:\n  command:\n    kind: exec\n    file: node\n");
    const loaded = await loadConfig(cwd);
    expect(loaded.config).toMatchObject({ version: 4, sourceVersion: 2, agent: { timeout_ms: 600_000 }, execution: { termination_grace_ms: 2_000, concurrency: 1, failure_mode: "continue", isolation: "shared" } });
    expect(loaded.warnings[0]).toContain("version 2");
    expect(Object.isFrozen(loaded.config)).toBe(true);
    expect(Object.isFrozen(loaded.config.agent)).toBe(true);
  });

  it("normalizes v1 string commands with a compatibility warning", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "ariadne.yml"), "version: 1\nagent:\n  command: node agent.mjs\nverification:\n  commands: [pnpm test]\n");
    const loaded = await loadConfig(cwd);
    expect(loaded.config.sourceVersion).toBe(1);
    expect(loaded.config.agent.command).toEqual({ kind: "shell", command: "node agent.mjs" });
    expect(loaded.warnings[0]).toContain("deprecated");
  });

  it("supports versionless legacy config intentionally", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "ariadne.yml"), "agent:\n  command: cat\n");
    expect((await loadConfig(cwd)).config.sourceVersion).toBe("versionless");
  });

  it.each([
    ["unknown field", "version: 2\nagent:\n  command:\n    kind: exec\n    file: node\nlist: {}\n", "Unrecognized key"],
    ["future version", "version: 99\nagent: {}\n", "not supported"],
    ["malformed version", "version: two\nagent: {}\n", "malformed"],
    ["unsafe task path", "version: 2\nagent:\n  command:\n    kind: exec\n    file: node\ntasks:\n  directory: ../tasks\n", "inside the project root"],
    ["Windows absolute task path", "version: 2\nagent:\n  command:\n    kind: exec\n    file: node\ntasks:\n  directory: C:\\\\tasks\n", "inside the project root"],
    ["negative forbidden pattern", "version: 2\nagent:\n  command:\n    kind: exec\n    file: node\nchecks:\n  forbidden_files: ['!.env']\n", "unsafe or unsupported"],
    ["invalid timeout", "version: 2\nagent:\n  command:\n    kind: exec\n    file: node\n  timeout_ms: 86400001\n", "<=86400000"]
  ])("rejects %s", async (_, source, message) => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "ariadne.yml"), source);
    await expect(loadConfig(cwd)).rejects.toThrow(message);
  });

  it("rejects config paths outside the invocation root", async () => {
    const cwd = await tempDir();
    await expect(loadConfig(cwd, "../ariadne.yml")).rejects.toThrow("inside the invocation root");
  });

  it("init writes a valid portable v4 config and remains idempotent", async () => {
    const cwd = await tempDir();
    expect((await initCommand(cwd)).config).toBe("created");
    expect((await initCommand(cwd)).config).toBe("skipped");
    const loaded = await loadConfig(cwd);
    expect(loaded.config.version).toBe(4);
    expect(loaded.config.agent.command).toMatchObject({ kind: "exec", file: "node" });
    expect(await readFile(path.join(cwd, ".gitignore"), "utf8")).toContain("/.ariadne/");
  });

  it("doctor reports missing package scripts with stable check IDs", async () => {
    const cwd = await tempDir();
    await writeProject(cwd, { agentArgs: ["test"] });
    const configPath = path.join(cwd, "ariadne.yml");
    const source = await readFile(configPath, "utf8");
    await writeFile(configPath, source.replace("file: node", "file: pnpm"));
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: {} }));
    const report = await diagnoseRepository(cwd);
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "agent.script", status: "fail" }));
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "tasks.duplicates", status: "pass" }));
  });

  it("doctor accepts creatable run storage when .ariadne does not exist yet", async () => {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, "tasks"));
    await writeFile(path.join(cwd, "tasks", "task.yml"), "id: task\nprompt: Work\n");
    await writeFile(path.join(cwd, "ariadne.yml"), "version: 2\nagent:\n  command:\n    kind: exec\n    file: node\ntasks:\n  directory: tasks\n");
    const report = await diagnoseRepository(cwd);
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "runs.writable", status: "pass" }));
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "batches.writable", status: "pass" }));
  });
});

describe("task contracts", () => {
  it("loads recursive tasks deterministically with filename fallback", async () => {
    const cwd = await tempDir();
    const tasks = path.join(cwd, "tasks");
    await mkdir(path.join(tasks, "nested"), { recursive: true });
    await writeFile(path.join(tasks, "b.yml"), "prompt: B\n");
    await writeFile(path.join(tasks, "nested", "a.yml"), "id: custom-a\nprompt: A\n");
    expect((await loadTasks(cwd, "tasks")).map((task) => task.id)).toEqual(["b", "custom-a"]);
  });

  it("rejects unknown task fields", async () => {
    const cwd = await tempDir();
    await writeProject(cwd);
    await writeFile(path.join(cwd, ".ariadne", "tasks", "example.yml"), "id: example\nprompt: Work\nunknown: true\n");
    await expect(loadTasks(cwd, ".ariadne/tasks")).rejects.toThrow("Unrecognized key");
  });

  it.each(["../bad", "white space", ".hidden", "x".repeat(65)])("rejects unsafe task id %s", async (id) => {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, "tasks"));
    await writeFile(path.join(cwd, "tasks", "bad.yml"), `id: ${JSON.stringify(id)}\nprompt: Work\n`);
    await expect(loadTasks(cwd, "tasks")).rejects.toThrow(/id must match|path-safe/);
  });

  it("rejects duplicate IDs case-insensitively with both paths", async () => {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, "tasks"));
    await writeFile(path.join(cwd, "tasks", "one.yml"), "id: Same\nprompt: One\n");
    await writeFile(path.join(cwd, "tasks", "two.yml"), "id: same\nprompt: Two\n");
    await expect(loadTasks(cwd, "tasks")).rejects.toThrow(/one\.yml[\s\S]*two\.yml/);
  });

  it("rejects duplicate ID keys in one YAML file", async () => {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, "tasks"));
    await writeFile(path.join(cwd, "tasks", "same.yml"), "id: same\nid: same\nprompt: Work\n");
    await expect(loadTasks(cwd, "tasks")).rejects.toThrow("Duplicate task id");
  });

  it("rejects conflicting duplicate ID keys in one YAML file", async () => {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, "tasks"));
    await writeFile(path.join(cwd, "tasks", "same.yml"), "id: one\nid: two\nprompt: Work\n");
    await expect(loadTasks(cwd, "tasks")).rejects.toThrow("more than once with conflicting values");
  });

  it.skipIf(process.platform === "win32")("rejects nested task symlinks outside the project root", async () => {
    const cwd = await tempDir();
    const outside = await tempDir();
    await mkdir(path.join(cwd, "tasks"));
    await writeFile(path.join(outside, "outside.yml"), "id: outside\nprompt: Work\n");
    await symlink(path.join(outside, "outside.yml"), path.join(cwd, "tasks", "outside.yml"));
    await expect(loadTasks(cwd, "tasks")).rejects.toThrow("symlink resolves outside");
  });
});
