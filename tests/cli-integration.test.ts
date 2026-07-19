import path from "node:path";
import { readFile, symlink, writeFile } from "node:fs/promises";
import fs from "fs-extra";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, initGit, tempDir, writeProject } from "./helpers.js";

const cliPath = path.resolve("dist/cli.js");
const documentedCommands = ["init", "doctor", "plan", "run", "benchmark", "resume", "rerun", "list", "report", "tui", "changes", "diff", "status", "apply", "discard", "worktree"] as const;

function cli(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8"
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

afterEach(cleanupTempDirs);

describe("CLI integration", () => {
  it("reads version metadata and lists the documented commands", () => {
    const cwd = process.cwd();
    const help = cli(cwd, ["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/benchmark/);
    expect(cli(cwd, ["--version"]).stdout.trim()).toBe("0.1.0");
  });

  it.each(documentedCommands)("exposes shared global options in %s help", (command) => {
    const help = cli(process.cwd(), [command, "--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Global Options:");
    expect(help.stdout).toContain("--json");
  });

  it("refuses non-interactive TUI use and rejects machine-output flags cleanly", async () => {
    const cwd = await tempDir();
    for (const args of [["tui"], ["tui", "--json"], ["tui", "--quiet"]]) {
      const result = cli(cwd, args);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain("\u001B");
    }
    expect(cli(cwd, ["tui"]).stderr).toContain("requires interactive stdin/stdout");
    expect(cli(cwd, ["tui", "--json"]).stderr).toContain("--json cannot be used");
  });

  it("keeps non-interactive init portable and requires a TTY for custom setup", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ packageManager: "pnpm@10.34.1", scripts: { check: "pnpm test" } }));
    const first = cli(cwd, ["init"]);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain(".ariadne/tasks/example.yml created");
    const generated = await readFile(path.join(cwd, "ariadne.yml"), "utf8");
    expect(generated).toContain("file: node");
    expect(generated).not.toContain("file: pnpm");
    const before = await readFile(path.join(cwd, "ariadne.yml"), "utf8");
    const second = cli(cwd, ["init"]);
    expect(second.status).toBe(0);
    expect(second.stderr).toContain("Nothing was changed");
    expect(await readFile(path.join(cwd, "ariadne.yml"), "utf8")).toBe(before);
    expect(cli(cwd, ["init", "--custom"]).status).toBe(2);
  });

  it("supports repository-aware detected defaults with init --yes", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ packageManager: "pnpm@10.34.1", scripts: { check: "node --check index.js", test: "node --test" }, devDependencies: { typescript: "^5.9.0" } }));
    await writeFile(path.join(cwd, "tsconfig.json"), "{}\n");
    const result = cli(cwd, ["init", "--yes", "--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ kind: "created", taskIds: ["check"], result: { config: "created", configurationValidated: true } });
    expect(result.stdout).not.toContain(cwd);
    expect(await readFile(path.join(cwd, ".ariadne", "tasks", "check.yml"), "utf8")).toContain("pnpm check");
  });

  it("keeps JSON stdout parseable while routing progress to stderr", async () => {
    const cwd = await tempDir();
    await writeProject(cwd);
    const result = cli(cwd, ["run", "--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ kind: "batch", schemaVersion: 3, outcome: "passed", batchStatus: "succeeded", manifestPath: expect.stringMatching(/^\.ariadne\/batches\//) });
    expect(result.stdout).not.toContain(cwd);
    expect(result.stderr).toContain("Running task: example");
  });

  it("plans dependency closure without creating execution records", async () => {
    const cwd = await tempDir();
    await writeProject(cwd, { tasks: [{ id: "a" }, { id: "b" }] });
    await writeFile(path.join(cwd, ".ariadne", "tasks", "b.yml"), "id: b\ndependsOn: [a]\nprompt: b\n");
    const result = cli(cwd, ["plan", "b", "--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ selectedRoots: ["b"], includedTasks: ["a", "b"], order: ["a", "b"] });
    expect(await fs.pathExists(path.join(cwd, ".ariadne", "runs"))).toBe(false);
    expect(await fs.pathExists(path.join(cwd, ".ariadne", "batches"))).toBe(false);
  });

  it("explains plan fields once without changing quiet or JSON output", async () => {
    const cwd = await tempDir();
    await writeProject(cwd);
    const marker = path.join(cwd, ".ariadne", "onboarding", "plan-guide-v1");

    const json = cli(cwd, ["plan", "--all", "--json"]);
    expect(JSON.parse(json.stdout).includedTasks).toEqual(["example"]);
    expect(await fs.pathExists(marker)).toBe(false);

    const quiet = cli(cwd, ["plan", "--all", "--quiet"]);
    expect(quiet.stdout).not.toContain("How to read this plan");
    expect(await fs.pathExists(marker)).toBe(false);

    const first = cli(cwd, ["plan", "--all"]);
    expect(first.stdout).toContain("How to read this plan (shown once)");
    expect(first.stdout).toContain("This is only a preview. No tasks have run yet.");
    expect(await fs.pathExists(marker)).toBe(true);

    const second = cli(cwd, ["plan", "--all"]);
    expect(second.stdout).not.toContain("How to read this plan");
  });

  it("keeps legacy plan JSON pure while routing compatibility warnings to stderr", async () => {
    const cwd = await tempDir();
    await fs.ensureDir(path.join(cwd, ".ariadne", "tasks"));
    await writeFile(path.join(cwd, "ariadne.yml"), "version: 2\nagent:\n  command: {kind: exec, file: node, args: []}\n");
    await writeFile(path.join(cwd, ".ariadne", "tasks", "a.yml"), "id: a\nprompt: a\n");
    const result = cli(cwd, ["plan", "--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).order).toEqual(["a"]);
    expect(result.stderr).toContain("version 2 is deprecated");
  });

  it("lists and reports workflow batches separately from child attempts", async () => {
    const cwd = await tempDir();
    await writeProject(cwd);
    const run = cli(cwd, ["run", "--json", "--quiet"]);
    const batch = JSON.parse(run.stdout);
    const listed = cli(cwd, ["list", "--batches", "--json", "--quiet"]);
    expect(JSON.parse(listed.stdout)[0]).toMatchObject({ batch_id: batch.batchId, status: "succeeded" });
    const report = cli(cwd, ["report", "--batch", batch.batchId, "--json", "--quiet"]);
    expect(JSON.parse(report.stdout)).toMatchObject({ kind: "batch", batchId: batch.batchId, batchStatus: "succeeded" });
    expect(JSON.parse(cli(cwd, ["list", "--tasks", "--json", "--quiet"]).stdout)[0]).toMatchObject({ run_id: batch.tasks[0].runId, batch_id: batch.batchId, attempt: 1 });
  });

  it("uses stable configuration, task-selection, and repository exit codes", async () => {
    const missingConfig = await tempDir();
    expect(cli(missingConfig, ["run", "--quiet"]).status).toBe(2);

    const missingTask = await tempDir();
    await writeProject(missingTask);
    expect(cli(missingTask, ["run", "--task", "missing", "--quiet"]).status).toBe(3);

    const gitRequired = await tempDir();
    await writeProject(gitRequired, { checks: "  forbidden_files: []\n  forbidden_commands: []\n  max_changed_files: 1" });
    expect(cli(gitRequired, ["run", "--quiet"]).status).toBe(4);
  });

  it("uses usage exit code 2 for parser-time option validation", async () => {
    const cwd = await tempDir();
    await writeProject(cwd);
    for (const args of [
      ["plan", "--all", "--concurrency", "33"],
      ["plan", "--all", "--failure-mode", "stop"],
      ["plan", "--all", "--isolation", "container"],
      ["list", "--format", "xml"]
    ]) {
      const result = cli(cwd, args);
      expect(result.status, `${args.join(" ")} stderr: ${result.stderr}`).toBe(2);
    }
  });

  it("lists real dirty paths in worktree-isolation diagnostics", async () => {
    const cwd = await tempDir();
    await writeProject(cwd);
    const config = await readFile(path.join(cwd, "ariadne.yml"), "utf8");
    await writeFile(path.join(cwd, "ariadne.yml"), config.replace("  isolation: shared", "  isolation: worktree"));
    await writeFile(path.join(cwd, ".gitignore"), "node_modules/\n");
    await initGit(cwd, {});
    await writeFile(path.join(cwd, "dirty file.txt"), "uncommitted\n");

    const result = cli(cwd, ["run", "--quiet"]);
    expect(result.status).toBe(4);
    expect(result.stdout).toContain("DIRTY_WORKTREE_BASE");
    expect(result.stdout).toContain("dirty file.txt");
  });

  it("uses stable execution and policy exit codes", async () => {
    const agentFailure = await tempDir();
    await writeProject(agentFailure, { agentArgs: ["-e", "process.exit(7)"] });
    expect(cli(agentFailure, ["run", "--quiet"]).status).toBe(10);

    const timeout = await tempDir();
    await writeProject(timeout, { agentArgs: ["-e", "setInterval(() => {}, 1000)"] });
    const timeoutConfig = await readFile(path.join(timeout, "ariadne.yml"), "utf8");
    await writeFile(path.join(timeout, "ariadne.yml"), timeoutConfig.replace("timeout_ms: 1000", "timeout_ms: 20"));
    expect(cli(timeout, ["run", "--quiet"]).status).toBe(11);

    const verification = await tempDir();
    await writeProject(verification);
    const verificationConfig = await readFile(path.join(verification, "ariadne.yml"), "utf8");
    await writeFile(path.join(verification, "ariadne.yml"), verificationConfig.replace("  commands: []", "  commands:\n    - kind: exec\n      file: node\n      args: [\"-e\", \"process.exit(2)\"]"));
    expect(cli(verification, ["run", "--quiet"]).status).toBe(12);

    const policy = await tempDir();
    await writeProject(policy, { checks: "  forbidden_files: []\n  forbidden_commands: [\"node -e\"]" });
    expect(cli(policy, ["run", "--quiet"]).status).toBe(13);
  });

  it("rejects conflicting output modes and never emits ANSI sequences", async () => {
    const cwd = await tempDir();
    await writeProject(cwd);
    expect(cli(cwd, ["list", "--json", "--csv"]).status).toBe(2);
    expect(cli(cwd, ["run", "example", "--all"]).status).toBe(2);
    expect(cli(cwd, ["rerun", "missing", "--all", "--failed"]).status).toBe(2);
    const output = cli(cwd, ["doctor", "--no-color"], { NO_COLOR: "1" });
    expect(`${output.stdout}${output.stderr}`).not.toMatch(/\u001b\[[0-9;]*m/);
  });

  it("uses configuration exit code 2 for output paths outside the invocation root", async () => {
    const cwd = await tempDir();
    const outside = await tempDir();
    await writeProject(cwd);
    expect(cli(cwd, ["run", "--quiet"]).status).toBe(0);
    const list = cli(cwd, ["list", "--output", "../outside.csv", "--format", "csv"]);
    const report = cli(cwd, ["report", "--output", "../outside.html"]);
    expect(list.status).toBe(2);
    expect(report.status).toBe(2);
    expect(list.stderr).toContain("OUTPUT_PATH_OUTSIDE_ROOT");
    expect(report.stderr).toContain("OUTPUT_PATH_OUTSIDE_ROOT");
    await symlink(outside, path.join(cwd, "escape"), process.platform === "win32" ? "junction" : "dir");
    const symlinked = cli(cwd, ["list", "--output", "escape/runs.csv", "--format", "csv"]);
    expect(symlinked.status).toBe(2);
    expect(symlinked.stderr).toContain("OUTPUT_PATH_OUTSIDE_ROOT");
  });
});
