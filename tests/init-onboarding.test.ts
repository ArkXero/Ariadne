import path from "node:path";
import { readFile, symlink, writeFile } from "node:fs/promises";
import fs from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";
import { runInteractiveInit, type InitPrompt } from "../src/commands/init.js";
import {
  applyInitProposal,
  buildInitProposal,
  defaultInitSettings,
  formatProposalDiff,
  initCommand
} from "../src/core/init.js";
import { loadConfig } from "../src/core/config.js";
import { detectRepository } from "../src/core/project-detector.js";
import { loadTasks } from "../src/core/task-loader.js";
import { cleanupTempDirs, initGit, tempDir, writeProject } from "./helpers.js";

class ScriptedPrompt implements InitPrompt {
  readonly messages: Array<{ kind: string; message: string; title?: string }> = [];

  constructor(
    private readonly selects: Array<string | number | boolean> = [],
    private readonly multis: Array<Array<string | number | boolean>> = [],
    private readonly confirms: boolean[] = [],
    private readonly texts: string[] = []
  ) {}

  intro(message: string): void { this.messages.push({ kind: "intro", message }); }
  outro(message: string): void { this.messages.push({ kind: "outro", message }); }
  cancel(message: string): void { this.messages.push({ kind: "cancel", message }); }
  note(message: string, title?: string): void { this.messages.push({ kind: "note", message, ...(title ? { title } : {}) }); }
  info(message: string): void { this.messages.push({ kind: "info", message }); }
  success(message: string): void { this.messages.push({ kind: "success", message }); }
  warning(message: string): void { this.messages.push({ kind: "warning", message }); }
  start(message: string): void { this.messages.push({ kind: "start", message }); }
  stop(message: string, success = true): void { this.messages.push({ kind: success ? "stop" : "stop-error", message }); }

  async select<T extends string | number | boolean>(): Promise<T> {
    const value = this.selects.shift();
    if (value === undefined) throw new Error("No scripted select response remains.");
    return value as T;
  }

  async multiselect<T extends string | number | boolean>(): Promise<T[]> {
    const value = this.multis.shift();
    if (value === undefined) throw new Error("No scripted multiselect response remains.");
    return value as T[];
  }

  async confirm(): Promise<boolean> {
    const value = this.confirms.shift();
    if (value === undefined) throw new Error("No scripted confirm response remains.");
    return value;
  }

  async text(options: { validate?: (value: string) => string | undefined }): Promise<string> {
    const value = this.texts.shift();
    if (value === undefined) throw new Error("No scripted text response remains.");
    const error = options.validate?.(value);
    if (error) throw new Error(`Scripted input was invalid: ${error}`);
    return value;
  }
}

afterEach(cleanupTempDirs);

async function writeDetectedProject(cwd: string): Promise<void> {
  await initGit(cwd, {
    "package.json": JSON.stringify({
      packageManager: "pnpm@10.34.1",
      scripts: { check: "pnpm lint && pnpm test", test: "vitest run", build: "tsc", dev: "vite" },
      devDependencies: { typescript: "^5.9.0" }
    }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "tsconfig.json": "{}\n"
  });
}

describe("init repository detection and proposals", () => {
  it("detects project type, package manager, scripts, validation, and worktree capability", async () => {
    const cwd = await tempDir();
    await writeDetectedProject(cwd);
    const detection = await detectRepository(cwd);
    expect(detection).toMatchObject({
      projectType: "TypeScript project",
      packageManager: "pnpm",
      validationCommand: { id: "check", display: "pnpm check" },
      git: { available: true, hasHead: true, worktreeIsolation: true }
    });
    expect(detection.commands.map((command) => command.id)).toEqual(["check", "test", "build", "dev"]);
  });

  it("creates a repository-aware default proposal that is valid and immediately runnable in shared mode", async () => {
    const cwd = await tempDir();
    await writeDetectedProject(cwd);
    const detection = await detectRepository(cwd);
    const proposal = await buildInitProposal(cwd, detection, defaultInitSettings(detection));
    expect(proposal.taskIds).toEqual(["check"]);
    expect(proposal.files).toContainEqual(expect.objectContaining({ path: ".ariadne/tasks/check.yml", action: "create" }));
    expect(proposal.configContents).toContain("isolation: shared");
    expect(proposal.configContents).toContain("file: pnpm");
    const result = await applyInitProposal(cwd, proposal);
    expect(result).toMatchObject({ config: "created", task: "created", configurationValidated: true });
    expect((await loadConfig(cwd)).config.execution.isolation).toBe("shared");
    expect((await loadTasks(cwd, ".ariadne/tasks"))[0].id).toBe("check");
    expect(await readFile(path.join(cwd, ".gitignore"), "utf8")).toContain("/ariadne.yml.backup-*");
  });

  it("validates, diffs, backs up, and atomically replaces an existing config without touching existing tasks", async () => {
    const cwd = await tempDir();
    const original = `# hand-tuned comment\nversion: 4\nagent:\n  command: {kind: exec, file: node, args: []}\nchecks:\n  forbidden_files: [secrets.txt]\n`;
    await fs.ensureDir(path.join(cwd, ".ariadne", "tasks"));
    await writeFile(path.join(cwd, "ariadne.yml"), original);
    await writeFile(path.join(cwd, ".ariadne", "tasks", "custom.yml"), "id: custom\nprompt: Preserve me\n");
    const detection = await detectRepository(cwd);
    const proposal = await buildInitProposal(cwd, detection, defaultInitSettings(detection));
    expect(formatProposalDiff(proposal)).toContain("-# hand-tuned comment");
    const result = await applyInitProposal(cwd, proposal);
    expect(result.config).toBe("replaced");
    expect(result.backup).toMatch(/^ariadne\.yml\.backup-/);
    expect(await readFile(path.join(cwd, result.backup!), "utf8")).toBe(original);
    expect(await readFile(path.join(cwd, ".ariadne", "tasks", "custom.yml"), "utf8")).toContain("Preserve me");
    expect((await loadConfig(cwd)).config.version).toBe(4);
  });

  it("does not mutate any existing file in non-interactive idempotent mode", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "ariadne.yml"), "# leave exactly as-is\n");
    await writeFile(path.join(cwd, ".gitignore"), "dist/\n");
    const result = await initCommand(cwd);
    expect(result).toMatchObject({ config: "skipped", runsDirectory: "untouched", batchesDirectory: "untouched" });
    expect(await readFile(path.join(cwd, "ariadne.yml"), "utf8")).toBe("# leave exactly as-is\n");
    expect(await readFile(path.join(cwd, ".gitignore"), "utf8")).toBe("dist/\n");
    expect(await fs.pathExists(path.join(cwd, ".ariadne"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("refuses initialization paths that are symlinks", async () => {
    const cwd = await tempDir();
    const outside = await tempDir();
    await writeFile(path.join(outside, "ariadne.yml"), "outside\n");
    await symlink(path.join(outside, "ariadne.yml"), path.join(cwd, "ariadne.yml"));
    const detection = await detectRepository(cwd);
    await expect(buildInitProposal(cwd, detection, defaultInitSettings(detection))).rejects.toThrow("will not read from or write through");
    expect(await readFile(path.join(outside, "ariadne.yml"), "utf8")).toBe("outside\n");
  });

  it("refuses to overwrite a file changed after proposal review", async () => {
    const cwd = await tempDir();
    await writeProject(cwd);
    const detection = await detectRepository(cwd);
    const proposal = await buildInitProposal(cwd, detection, defaultInitSettings(detection));
    await writeFile(path.join(cwd, "ariadne.yml"), "# changed after review\n");
    await expect(applyInitProposal(cwd, proposal)).rejects.toThrow("changed after the proposal was reviewed");
    expect(await readFile(path.join(cwd, "ariadne.yml"), "utf8")).toBe("# changed after review\n");
    expect((await fs.readdir(cwd)).some((entry) => entry.startsWith("ariadne.yml.backup-"))).toBe(false);
  });
});

describe("interactive init onboarding", () => {
  it("supports the complete custom setup and review flow", async () => {
    const cwd = await tempDir();
    await writeDetectedProject(cwd);
    const ui = new ScriptedPrompt(
      ["custom", "custom", "sequential", "worktree", "yaml", "changes", "create"],
      [["check", "test", "build"]],
      [true],
      ["node", '["-e","process.stdin.resume()"]', "2", "2", "25", "1500", "30"]
    );
    const outcome = await runInteractiveInit(cwd, ui);
    expect(outcome.kind).toBe("created");
    const loaded = await loadConfig(cwd);
    expect(loaded.config).toMatchObject({
      agent: { command: { kind: "exec", file: "node", args: ["-e", "process.stdin.resume()"] }, timeout_ms: 1_800_000 },
      execution: { isolation: "worktree", concurrency: 2 },
      checks: { max_changed_files: 25, max_diff_lines: 1_500 }
    });
    const tasks = await loadTasks(cwd, ".ariadne/tasks");
    expect(tasks.map((task) => task.id)).toEqual(["build", "check", "test"]);
    expect(tasks.find((task) => task.id === "test")?.dependsOn).toEqual(["check"]);
    expect(tasks.find((task) => task.id === "build")?.dependsOn).toEqual(["test"]);
    expect(tasks.every((task) => task.retry.attempts === 2)).toBe(true);
    expect(ui.messages).toContainEqual(expect.objectContaining({ kind: "note", title: "ariadne.yml" }));
    expect(ui.messages).toContainEqual(expect.objectContaining({ kind: "note", title: "Proposed file changes" }));
  });

  it("cancels before writes and reports that no files changed", async () => {
    const cwd = await tempDir();
    const ui = new ScriptedPrompt(["default"], [], [false]);
    await expect(runInteractiveInit(cwd, ui)).rejects.toThrow();
    expect(await fs.pathExists(path.join(cwd, "ariadne.yml"))).toBe(false);
    expect(await fs.pathExists(path.join(cwd, ".ariadne"))).toBe(false);
    expect(ui.messages.at(-1)).toMatchObject({ kind: "cancel", message: "Operation cancelled. No files were changed." });
  });

  it("defaults to validating an existing configuration without rewriting it", async () => {
    const cwd = await tempDir();
    await writeProject(cwd);
    const before = await readFile(path.join(cwd, "ariadne.yml"), "utf8");
    const ui = new ScriptedPrompt(["validate"]);
    const outcome = await runInteractiveInit(cwd, ui);
    expect(outcome.kind).toBe("validated");
    expect(await readFile(path.join(cwd, "ariadne.yml"), "utf8")).toBe(before);
    expect(ui.messages).toContainEqual(expect.objectContaining({ kind: "note", title: "Validation result" }));
  });

  it("always displays the replacement diff and creates a backup before replacing", async () => {
    const cwd = await tempDir();
    await writeProject(cwd);
    const configPath = path.join(cwd, "ariadne.yml");
    const original = `# preserve in backup\n${await readFile(configPath, "utf8")}`;
    await writeFile(configPath, original);
    const ui = new ScriptedPrompt(["default"], [], [true]);
    const outcome = await runInteractiveInit(cwd, ui);
    expect(outcome.kind).toBe("created");
    if (outcome.kind !== "created") throw new Error("Expected a replacement outcome.");
    expect(outcome.result.backup).toMatch(/^ariadne\.yml\.backup-/);
    expect(await readFile(path.join(cwd, outcome.result.backup!), "utf8")).toBe(original);
    expect(ui.messages).toContainEqual(expect.objectContaining({ kind: "note", title: "Required replacement diff", message: expect.stringContaining("-# preserve in backup") }));
  });
});
