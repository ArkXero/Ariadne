import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, tempDir, writeProject } from "./helpers.js";

const cliPath = path.resolve("dist/cli.js");

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
  it("reads version metadata and exposes the documented commands", async () => {
    const cwd = await tempDir();
    const help = cli(cwd, ["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/init|doctor|run|list|report/);
    expect(cli(cwd, ["--version"]).stdout.trim()).toBe("0.1.0");
    for (const command of ["init", "doctor", "run", "list", "report"]) {
      expect(cli(cwd, [command, "--help"]).stdout).toContain("Global Options:");
      expect(cli(cwd, [command, "--help"]).stdout).toContain("--json");
    }
  });

  it("keeps JSON stdout parseable while routing progress to stderr", async () => {
    const cwd = await tempDir();
    await writeProject(cwd);
    const result = cli(cwd, ["run", "--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 2, outcome: "passed", manifestPath: expect.stringMatching(/^\.ariadne\/runs\//) });
    expect(result.stdout).not.toContain(cwd);
    expect(result.stderr).toContain("Running task: example");
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
    const output = cli(cwd, ["doctor", "--no-color"], { NO_COLOR: "1" });
    expect(`${output.stdout}${output.stderr}`).not.toMatch(/\u001b\[[0-9;]*m/);
  });

  it("uses configuration exit code 2 for output paths outside the invocation root", async () => {
    const cwd = await tempDir();
    await writeProject(cwd);
    expect(cli(cwd, ["run", "--quiet"]).status).toBe(0);
    const list = cli(cwd, ["list", "--output", "../outside.csv", "--format", "csv"]);
    const report = cli(cwd, ["report", "--output", "../outside.html"]);
    expect(list.status).toBe(2);
    expect(report.status).toBe(2);
    expect(list.stderr).toContain("OUTPUT_PATH_OUTSIDE_ROOT");
    expect(report.stderr).toContain("OUTPUT_PATH_OUTSIDE_ROOT");
  });
});
