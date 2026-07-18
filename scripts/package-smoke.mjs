import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ariadne-package-"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args, cwd, expected = 0, environment = {}) {
  const windowsShim = process.platform === "win32" && (["npm", "pnpm", "corepack", "ariadne"].includes(command) || /\.(?:cmd|bat)$/i.test(command));
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", ...environment }, shell: windowsShim });
  if (result.status !== expected) {
    throw new Error([`Command failed: ${command} ${args.join(" ")}`, `cwd: ${cwd}`, `expected ${expected}, got ${result.status}`, "stdout:", result.stdout, "stderr:", result.stderr].join("\n"));
  }
  return result;
}

async function latestRecord(cwd) {
  const pointer = JSON.parse(await readFile(path.join(cwd, ".ariadne", "runs", "latest.json"), "utf8"));
  assert(typeof pointer.runId === "string", "latest.json is missing runId.");
  assert(pointer.manifest === `${pointer.runId}/run.json`, `latest.json manifest contradicts runId: ${JSON.stringify(pointer)}`);
  const manifestPath = path.join(cwd, ".ariadne", "runs", pointer.manifest);
  const record = JSON.parse(await readFile(manifestPath, "utf8"));
  assert(record.runId === pointer.runId, `latest.json points to a contradictory manifest: ${record.runId} != ${pointer.runId}`);
  return { pointer, record, manifestPath };
}

async function latestBatch(cwd) {
  const pointer = JSON.parse(await readFile(path.join(cwd, ".ariadne", "batches", "latest.json"), "utf8"));
  assert(typeof pointer.batchId === "string", "batch latest.json is missing batchId.");
  assert(pointer.manifest === `${pointer.batchId}/batch.json`, `Batch latest pointer contradicts batchId: ${JSON.stringify(pointer)}`);
  const manifestPath = path.join(cwd, ".ariadne", "batches", pointer.manifest);
  const record = JSON.parse(await readFile(manifestPath, "utf8"));
  assert(record.batchId === pointer.batchId, "Batch latest pointer references a contradictory manifest.");
  return { pointer, record, manifestPath };
}

async function createFixture(name, options = {}) {
  const cwd = path.join(temporaryRoot, `fixture-${name}`);
  await mkdir(path.join(cwd, ".ariadne", "tasks"), { recursive: true });
  await writeFile(path.join(cwd, ".gitignore"), ".ariadne/runs/\n.ariadne/batches/\n.ariadne/worktrees/\n.ariadne/promotions/\n.ariadne/actions/\n.ariadne/exports/\n.ariadne/locks/\n.ariadne/latest.json\n.env\nnode_modules/\n");
  await writeFile(path.join(cwd, "target.txt"), "committed\n");
  await writeFile(path.join(cwd, "agent.mjs"), options.agentSource ?? "process.stdin.resume();\n");
  await writeFile(path.join(cwd, ".ariadne", "tasks", "task.yml"), `${JSON.stringify({
    id: "task",
    name: options.taskName ?? name,
    prompt: `Run the deterministic ${name} package fixture.`,
    dependsOn: [],
    workspaceMode: "mutable",
    retry: options.retry ?? { attempts: 1, delayMs: 0, backoff: "fixed" }
  }, null, 2)}\n`);
  await writeFile(path.join(cwd, "ariadne.yml"), `${JSON.stringify({
    version: 4,
    agent: {
      command: { kind: "exec", file: "node", args: ["agent.mjs"] },
      timeout_ms: options.timeoutMs ?? 1_000
    },
    tasks: { directory: ".ariadne/tasks" },
    verification: {
      commands: options.verification ?? [],
      timeout_ms: options.verificationTimeoutMs ?? 1_000
    },
    execution: {
      termination_grace_ms: 100, concurrency: options.concurrency ?? 1, failure_mode: options.failureMode ?? "continue",
      isolation: options.isolation ?? "shared",
      worktree: { retention: options.retention ?? "on-failure", preparation: { commands: options.preparation ?? [], timeout_ms: 1_000 } }
    },
    checks: {
      forbidden_files: options.forbiddenFiles ?? [],
      forbidden_commands: options.forbiddenCommands ?? [],
      ...(options.maxChangedFiles === undefined ? {} : { max_changed_files: options.maxChangedFiles }),
      ...(options.maxDiffLines === undefined ? {} : { max_diff_lines: options.maxDiffLines })
    }
  }, null, 2)}\n`);
  run("git", ["init", "--quiet"], cwd);
  run("git", ["add", "."], cwd);
  run("git", ["-c", "user.name=Ariadne Package", "-c", "user.email=package@example.test", "commit", "--quiet", "-m", "fixture"], cwd);
  return cwd;
}

async function packageTextFiles(directory) {
  const files = [];
  const visit = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (/\.(?:js|map|json|md|d\.ts)$/.test(entry.name)) files.push(absolute);
    }
  };
  await visit(directory);
  return files;
}

async function interruptInstalledRun(installedCli, cwd) {
  const child = spawn(process.execPath, [installedCli, "run", "--quiet"], {
    cwd,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const started = await readFile(path.join(cwd, "agent-started"), "utf8").catch(() => undefined);
    if (started) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert(await readFile(path.join(cwd, "agent-started"), "utf8").catch(() => undefined), "Interrupted agent did not start in time.");
  child.kill("SIGINT");
  const { code, signal } = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
  });
  if (code !== 130) throw new Error(`Interrupted installed CLI exited code=${code} signal=${signal}\n${stdout}\n${stderr}`);
}

try {
  const packed = run("npm", ["pack", "--json", "--pack-destination", temporaryRoot], repoRoot);
  const metadata = JSON.parse(packed.stdout)[0];
  assert(metadata?.filename && Array.isArray(metadata.files), `Unexpected npm pack metadata: ${packed.stdout}`);
  const names = metadata.files.map((file) => file.path);
  const forbiddenNames = names.filter((name) =>
    name.startsWith("src/")
    || name.startsWith("tests/")
    || name.startsWith("scripts/")
    || name.includes("task-validation")
    || name.includes("trace-schema")
    || name === "dist/schema/report.js"
    || name === "dist/schema/report.d.ts"
    || name === "dist/schema/report.js.map"
    || /(^|\/)(?:\.ariadne|\.env(?:\..*)?|\.DS_Store|\.idea|\.vscode)(?:\/|$)/.test(name)
    || /\.(?:swp|swo|tmp)$/.test(name)
  );
  assert(forbiddenNames.length === 0, `Package contains development, secret, editor, or temporary files: ${forbiddenNames.join(", ")}`);
  for (const required of ["dist/cli.js", "README.md", "LICENSE", "package.json"]) {
    assert(names.includes(required), `Package is missing ${required}`);
  }

  const installRoot = path.join(temporaryRoot, "install with space ünicode");
  await mkdir(installRoot);
  await writeFile(path.join(installRoot, "package.json"), JSON.stringify({ private: true }));
  const tarball = path.join(temporaryRoot, metadata.filename);
  run("npm", ["install", "--ignore-scripts", "--package-lock=false", tarball], installRoot);
  const packageDirectory = path.join(installRoot, "node_modules", "@arkxronts", "ariadne");
  const installedCli = path.join(packageDirectory, "dist", "cli.js");
  const binary = process.platform === "win32"
    ? path.join(installRoot, "node_modules", ".bin", "ariadne.cmd")
    : path.join(installRoot, "node_modules", ".bin", "ariadne");
  assert((await readFile(installedCli, "utf8")).startsWith("#!/usr/bin/env node"), "Installed CLI is missing its Node shebang.");
  const installedPackage = JSON.parse(await readFile(path.join(packageDirectory, "package.json"), "utf8"));
  assert(installedPackage.bin?.ariadne === "dist/cli.js", "Installed package bin metadata is invalid.");
  assert(installedPackage.license === "Apache-2.0" && installedPackage.main === undefined, "Installed package metadata is stale or misleading.");
  for (const file of await packageTextFiles(packageDirectory)) {
    const contents = await readFile(file, "utf8");
    assert(!contents.includes(repoRoot), `Packaged file contains the source-checkout path: ${path.relative(packageDirectory, file)}`);
  }

  const help = run(binary, ["--help"], installRoot);
  assert(help.stdout.includes("Usage: ariadne"), "Installed CLI help output was invalid.");
  for (const command of ["init", "doctor", "plan", "run", "resume", "rerun", "list", "report", "tui", "changes", "diff", "status", "apply", "discard", "worktree"]) {
    assert(run(binary, [command, "--help"], installRoot).stdout.includes(`Usage: ariadne ${command}`), `Installed ${command} help was invalid.`);
  }
  for (const command of ["list", "remove", "clean"]) {
    assert(run(binary, ["worktree", command, "--help"], installRoot).stdout.includes(`Usage: ariadne worktree ${command}`), `Installed worktree ${command} help was invalid.`);
  }
  const version = run(binary, ["--version"], installRoot).stdout.trim();
  assert(version === installedPackage.version, `Installed CLI version ${version} does not match package ${installedPackage.version}`);
  assert(run(process.execPath, [installedCli, "--version"], installRoot).stdout.trim() === version, "Direct installed CLI invocation returned the wrong version.");

  const globalRoot = path.join(temporaryRoot, "npm global prefix");
  run("npm", ["install", "--global", "--prefix", globalRoot, "--ignore-scripts", tarball], temporaryRoot);
  const globalBinary = process.platform === "win32" ? path.join(globalRoot, "ariadne.cmd") : path.join(globalRoot, "bin", "ariadne");
  assert(run(globalBinary, ["--version"], temporaryRoot).stdout.trim() === version, "npm global tarball installation returned the wrong version.");

  const npmExec = run("npm", ["exec", "--yes", `--package=${tarball}`, "--", "ariadne", "--version"], temporaryRoot);
  assert(npmExec.stdout.trim() === version, "npm exec tarball invocation returned the wrong version.");

  const pnpmInstallRoot = path.join(temporaryRoot, "pnpm local install");
  await mkdir(pnpmInstallRoot);
  await writeFile(path.join(pnpmInstallRoot, "package.json"), JSON.stringify({ private: true }));
  run("pnpm", ["add", "--ignore-scripts", tarball], pnpmInstallRoot);
  const pnpmBinary = process.platform === "win32"
    ? path.join(pnpmInstallRoot, "node_modules", ".bin", "ariadne.CMD")
    : path.join(pnpmInstallRoot, "node_modules", ".bin", "ariadne");
  assert(run(pnpmBinary, ["--version"], pnpmInstallRoot).stdout.trim() === version, "pnpm local tarball installation returned the wrong version.");
  const tuiRefusal = run(binary, ["tui"], installRoot, 2);
  assert(tuiRefusal.stdout === "" && !tuiRefusal.stderr.includes("\u001B") && tuiRefusal.stderr.includes("interactive stdin/stdout"), "Installed TUI non-TTY refusal was not clean.");
  const installedPty = run(process.execPath, [path.join(repoRoot, "scripts", "tui-pty-smoke.mjs")], installRoot, 0, { ARIADNE_TUI_CLI: installedCli });
  assert(installedPty.stdout.includes("TUI PTY smoke passed") || installedPty.stdout.includes("TUI PTY smoke skipped"), "Installed TUI PTY smoke did not report a supported or explicit fallback result.");
  for (const args of [
    ["plan", "--all", "--concurrency", "33"],
    ["plan", "--all", "--failure-mode", "stop"],
    ["plan", "--all", "--isolation", "container"],
    ["list", "--format", "xml"]
  ]) {
    run(binary, args, installRoot, 2);
  }

  const passing = path.join(temporaryRoot, "fixture passing ünicode");
  await mkdir(passing);
  run("git", ["init", "--quiet"], passing);
  run(binary, ["init"], passing);
  const hostileName = "=2+3 | <script>alert(1)</script><img src=x onerror=alert(1)>";
  await writeFile(path.join(passing, ".ariadne", "tasks", "example.yml"), `${JSON.stringify({ id: "example", name: hostileName, prompt: "Complete the installed-package task." }, null, 2)}\n`);
  run(binary, ["doctor", "--quiet"], passing);
  const nested = path.join(passing, "nested directory");
  await mkdir(nested);
  const nestedResult = run(binary, ["plan", "--all", "--json"], nested, 2);
  assert(nestedResult.stdout === "" && nestedResult.stderr.includes("Config not found"), "Nested invocation did not fail safely with project-root guidance.");
  const planned = JSON.parse(run(binary, ["plan", "--all", "--json"], passing).stdout);
  assert(planned.order?.join(",") === "example", "Installed workflow plan was invalid.");
  const terminalRun = run(binary, ["run", "--quiet"], passing);
  assert(terminalRun.stdout.includes("Status: completed") && terminalRun.stdout.includes("Outcome: passed"), `Terminal run contradicted a passing result: ${terminalRun.stdout}`);
  const first = await latestRecord(passing);
  const firstBatch = await latestBatch(passing);
  const jsonRun = run(binary, ["run", "--json"], passing);
  const runJson = JSON.parse(jsonRun.stdout);
  assert(runJson.status === "completed" && runJson.outcome === "passed", `JSON run contradicted a passing result: ${jsonRun.stdout}`);
  assert(jsonRun.stderr.includes("Running task: example"), "JSON mode did not route progress to stderr.");
  assert(!jsonRun.stdout.includes(passing), "JSON stdout leaked the absolute fixture path.");
  const second = await latestRecord(passing);
  const secondBatch = await latestBatch(passing);
  assert(first.record.runId !== second.record.runId, "Consecutive runs reused a run ID.");
  assert(firstBatch.record.batchId !== secondBatch.record.batchId, "Consecutive workflows reused a batch ID.");
  assert(secondBatch.record.kind === "batch" && secondBatch.record.runId === secondBatch.record.batchId && secondBatch.record.status === "completed" && secondBatch.record.batchStatus === "succeeded" && secondBatch.record.outcome === "passed", "Batch compatibility aliases are invalid.");
  assert(secondBatch.record.lifecycle.some((event) => event.taskId === "example" && event.detail?.includes("Attempt 1 started")), "Batch lifecycle is missing task-attempt checkpoints.");
  assert(secondBatch.record.summary.outcome === runJson.outcome && secondBatch.record.batchId === runJson.batchId, "Persisted batch and run JSON disagree.");

  await writeFile(path.join(passing, ".ariadne", "runs", "broken.json"), "{broken");
  const listJsonResult = run(binary, ["list", "--format", "json"], passing);
  const listJson = JSON.parse(listJsonResult.stdout);
  assert(listJsonResult.stderr.includes("broken.json"), "Corrupt history did not produce a stderr warning.");
  assert(listJson[0]?.status === "completed" && listJson[0]?.outcome === "passed" && listJson[0]?.task_name === hostileName, "List JSON contradicts the latest passing record.");
  const listCsv = run(binary, ["list", "--format", "csv", "--quiet"], passing).stdout;
  const listMarkdown = run(binary, ["list", "--format", "markdown", "--quiet"], passing).stdout;
  assert(listCsv.includes("completed,passed") && listCsv.includes("'=2+3"), "CSV output contradicts status or failed formula neutralization.");
  assert(listMarkdown.includes("completed | passed") && listMarkdown.includes("\\|") && listMarkdown.includes("&lt;script&gt;") && !listMarkdown.includes("<script>"), "Markdown output contradicted status or failed hostile-HTML escaping.");
  const batchList = JSON.parse(run(binary, ["list", "--batches", "--format", "json", "--quiet"], passing).stdout);
  assert(batchList[0]?.batch_id === secondBatch.record.batchId && batchList[0]?.status === "succeeded", "Batch history contradicts latest batch.");
  const reportResult = run(binary, ["report", "--json", "--quiet"], passing);
  const reportJson = JSON.parse(reportResult.stdout);
  assert(reportJson.batchId === secondBatch.record.batchId && reportJson.status === "completed" && reportJson.outcome === "passed", "Report JSON contradicts latest invocation or batch record.");
  assert(reportJson.tasks[0]?.name === hostileName && reportJson.tasks[0]?.score === second.record.results[0].score.value, "Report JSON contradicts persisted task data.");
  const htmlPath = path.join(passing, ".ariadne", "batches", secondBatch.record.batchId, "report.html");
  const html = await readFile(htmlPath, "utf8");
  assert(!html.includes("<script>alert(1)</script>") && !html.includes("onerror=alert(1)>") && html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "HTML report failed hostile-content escaping.");
  assert(html.includes("succeeded") && html.includes("passed") && html.includes(String(second.record.results[0].score.value)), "HTML report contradicts the canonical status or score.");

  const isolated = await createFixture("isolated", {
    isolation: "worktree", retention: "never",
    agentSource: "import { appendFile } from 'node:fs/promises'; process.stdin.resume(); await appendFile('target.txt', 'isolated\\n');\n"
  });
  await mkdir(path.join(isolated, "node_modules", "fixture"), { recursive: true });
  await writeFile(path.join(isolated, "node_modules", "fixture", "index.js"), "ignored fixture\n");
  const isolatedDoctor = run(binary, ["doctor", "--json"], isolated);
  const isolatedDoctorReport = JSON.parse(isolatedDoctor.stdout);
  assert(isolatedDoctorReport.checks.find((check) => check.id === "worktree.source-clean")?.status === "pass", "Ignored node_modules made installed doctor report a dirty repository.");
  run(binary, ["run", "--quiet"], isolated);
  const isolatedRun = (await latestRecord(isolated)).record;
  assert(isolatedRun.workspace?.strategy === "worktree" && isolatedRun.changeArtifact?.applicable === true, "Installed worktree run did not persist an applicable result.");
  assert(isolatedRun.changeArtifact?.schemaVersion === 2 && isolatedRun.changeArtifact.changes.every((change) => change.changeId && change.diff), "Installed package did not capture change-artifact v2 metadata.");
  assert(await readFile(path.join(isolated, "target.txt"), "utf8") === "committed\n", "Isolated run mutated the primary checkout.");
  const changes = JSON.parse(run(binary, ["changes", isolatedRun.runId, "--json"], isolated).stdout);
  assert(changes.changes.some((change) => change.path === "target.txt") && changes.promotion === "unapplied", "Installed changes view contradicted the result artifact.");
  const unapplied = JSON.parse(run(binary, ["list", "--unapplied", "--json", "--quiet"], isolated).stdout);
  assert(unapplied.length === 1 && unapplied[0].run_id === isolatedRun.runId && unapplied[0].promotion === "unapplied", "Installed unapplied history filter was inconsistent.");
  run(binary, ["diff", isolatedRun.runId, "--output", ".ariadne/export/result.patch", "--quiet"], isolated);
  assert((await readFile(path.join(isolated, ".ariadne", "export", "result.patch"), "utf8")).includes("target.txt"), "Installed diff did not copy the complete safe patch.");
  run(binary, ["diff", isolatedRun.runId, "--output", ".ariadne/export/result.patch", "--quiet"], isolated, 2);
  run(binary, ["diff", isolatedRun.runId, "--output", ".ariadne/export/result.patch", "--force", "--quiet"], isolated);
  run(binary, ["apply", isolatedRun.runId, "--quiet"], isolated);
  assert(await readFile(path.join(isolated, "target.txt"), "utf8") === "committed\nisolated\n", "Installed clean promotion did not update the primary checkout.");
  assert(JSON.parse(run(binary, ["status", isolatedRun.runId, "--json"], isolated).stdout).promotion === "applied", "Installed status did not report the applied result.");
  const appliedHistory = JSON.parse(run(binary, ["list", "--applied", "--json", "--quiet"], isolated).stdout);
  assert(appliedHistory.length === 1 && appliedHistory[0].run_id === isolatedRun.runId && appliedHistory[0].promotion === "applied", "Installed applied history filter was inconsistent.");

  const conflict = await createFixture("conflict", {
    isolation: "worktree", retention: "never",
    agentSource: "import { writeFile } from 'node:fs/promises'; process.stdin.resume(); await writeFile('target.txt', 'result\\n');\n"
  });
  run(binary, ["run", "--quiet"], conflict);
  const conflictRun = (await latestRecord(conflict)).record;
  await writeFile(path.join(conflict, "target.txt"), "primary\n");
  run("git", ["add", "target.txt"], conflict);
  run("git", ["-c", "user.name=Ariadne Package", "-c", "user.email=package@example.test", "commit", "--quiet", "-m", "advance"], conflict);
  run(binary, ["apply", conflictRun.runId, "--quiet"], conflict, 15);
  assert(await readFile(path.join(conflict, "target.txt"), "utf8") === "primary\n", "Promotion conflict changed the primary checkout.");
  const conflictEvents = await readdir(path.join(conflict, ".ariadne", "promotions"));
  const conflictEvent = JSON.parse(await readFile(path.join(conflict, ".ariadne", "promotions", conflictEvents.at(-1)), "utf8"));
  assert(conflictEvent.schemaVersion === 2 && conflictEvent.status === "conflicted" && conflictEvent.failure?.category === "conflict" && conflictEvent.failure.targetModified === false, "Installed conflict did not persist structured rollback state.");

  const discarded = await createFixture("discard", {
    isolation: "worktree", retention: "always",
    agentSource: "import { appendFile } from 'node:fs/promises'; process.stdin.resume(); await appendFile('target.txt', 'discard\\n');\n"
  });
  run(binary, ["run", "--quiet"], discarded);
  const discardedRun = (await latestRecord(discarded)).record;
  run(binary, ["discard", discardedRun.runId, "--quiet"], discarded);
  run(binary, ["discard", discardedRun.runId, "--quiet"], discarded);
  assert(JSON.parse(run(binary, ["status", discardedRun.runId, "--json"], discarded).stdout).promotion === "discarded", "Installed discard status was inconsistent.");
  const discardedHistory = JSON.parse(run(binary, ["list", "--discarded", "--json", "--quiet"], discarded).stdout);
  assert(discardedHistory.length === 1 && discardedHistory[0].run_id === discardedRun.runId && discardedHistory[0].promotion === "discarded", "Installed discarded history filter was inconsistent.");
  const discardedWorkspace = JSON.parse(await readFile(path.join(discarded, discardedRun.workspace.metadataPath), "utf8"));
  assert(discardedWorkspace.state === "removed", "Installed discard did not remove its retained managed worktree.");
  await mkdir(path.join(discarded, ".ariadne", "worktrees", "corrupt"), { recursive: true });
  await writeFile(path.join(discarded, ".ariadne", "worktrees", "corrupt", "workspace.json"), "{broken");
  const worktrees = JSON.parse(run(binary, ["worktree", "list", "--json"], discarded).stdout);
  assert(worktrees.some((item) => item.warning), "Corrupt workspace metadata was not warned and skipped.");
  const discardedActionCount = await readdir(path.join(discarded, ".ariadne", "actions")).then((items) => items.length, () => 0);
  run(binary, ["worktree", "clean", "--dry-run", "--quiet"], discarded);
  assert(await readdir(path.join(discarded, ".ariadne", "actions")).then((items) => items.length, () => 0) === discardedActionCount, "Installed cleanup dry run created a management action.");

  const cleanup = await createFixture("cleanup", {
    isolation: "worktree", retention: "always",
    agentSource: "import { appendFile } from 'node:fs/promises'; process.stdin.resume(); await appendFile('target.txt', 'cleanup\\n');\n"
  });
  run(binary, ["run", "--quiet"], cleanup);
  const cleanupRun = (await latestRecord(cleanup)).record;
  run(binary, ["worktree", "clean", "--dry-run", "--quiet"], cleanup);
  assert(await readdir(path.join(cleanup, ".ariadne", "actions")).then((items) => items.length, () => 0) === 0, "Installed cleanup dry run was not pure.");
  run(binary, ["worktree", "clean", "--quiet"], cleanup);
  const cleanupWorkspace = JSON.parse(await readFile(path.join(cleanup, cleanupRun.workspace.metadataPath), "utf8"));
  assert(cleanupWorkspace.state === "removed", "Installed cleanup did not remove an eligible retained workspace.");
  const cleanupActions = await readdir(path.join(cleanup, ".ariadne", "actions"));
  const cleanupAction = JSON.parse(await readFile(path.join(cleanup, ".ariadne", "actions", cleanupActions[0]), "utf8"));
  assert(cleanupAction.schemaVersion === 1 && cleanupAction.kind === "workspace-cleanup" && cleanupAction.status === "succeeded", "Installed cleanup did not persist management-action v1 history.");

  const agentFailure = await createFixture("agent-failure", { agentSource: "process.exit(7);\n" });
  run(binary, ["run", "--quiet"], agentFailure, 10);
  assert((await latestRecord(agentFailure)).record.summary.outcome === "agent_failed", "Agent failure was not persisted.");

  const preparationFailure = await createFixture("preparation-failure", {
    isolation: "worktree",
    preparation: [{ kind: "exec", file: "node", args: ["-e", "process.exit(9)"] }]
  });
  const preparationResult = run(binary, ["run", "--quiet"], preparationFailure, 14);
  assert(preparationResult.stdout.includes("Outcome: preparation_failed"), "Preparation failure terminal output contradicted its outcome.");
  const preparationRecord = (await latestRecord(preparationFailure)).record;
  const preparationBatch = (await latestBatch(preparationFailure)).record;
  assert(preparationRecord.summary.outcome === "preparation_failed", "Preparation failure child record was not persisted correctly.");
  assert(preparationBatch.outcome === "preparation_failed" && preparationBatch.summary.outcome === "preparation_failed", "Preparation failure batch aggregation contradicted its child attempt.");

  const verificationFailure = await createFixture("verification-failure", {
    verification: [{ kind: "exec", file: "node", args: ["-e", "process.exit(2)"] }]
  });
  run(binary, ["run", "--quiet"], verificationFailure, 12);
  assert((await latestRecord(verificationFailure)).record.summary.outcome === "verification_failed", "Verification failure was not persisted.");

  const policyFailure = await createFixture("policy-failure", {
    agentSource: "import { writeFile } from 'node:fs/promises'; process.stdin.resume(); await writeFile('.env', 'fixture=true\\n');\n",
    forbiddenFiles: [".env"]
  });
  run(binary, ["run", "--quiet"], policyFailure, 13);
  const policyRecord = (await latestRecord(policyFailure)).record;
  assert(policyRecord.summary.outcome === "policy_failed", "Policy failure was not persisted.");
  assert(policyRecord.results[0].trace.forbiddenFileChanges.some((change) => change.path === ".env"), "Ignored forbidden-file evidence is missing.");

  const dirtyBaseline = await createFixture("dirty-baseline", {
    agentSource: "import { appendFile } from 'node:fs/promises'; process.stdin.resume(); await appendFile('target.txt', 'agent edit\\n');\n",
    maxChangedFiles: 5,
    maxDiffLines: 20
  });
  await writeFile(path.join(dirtyBaseline, "target.txt"), "preexisting dirt\n");
  run(binary, ["run", "--quiet"], dirtyBaseline);
  const dirtyRecord = (await latestRecord(dirtyBaseline)).record;
  assert(dirtyRecord.results[0].trace.preexistingChanges.some((change) => change.path === "target.txt"), "Dirty baseline was not recorded.");
  assert(dirtyRecord.results[0].trace.taskChanges.some((change) => change.path === "target.txt"), "Agent edit to dirty baseline was not attributed.");

  const timeout = await createFixture("timeout", { agentSource: "setInterval(() => {}, 1000);\n", timeoutMs: 25 });
  run(binary, ["run", "--quiet"], timeout, 11);
  const timeoutRecord = (await latestRecord(timeout)).record;
  assert(timeoutRecord.status === "failed" && timeoutRecord.summary.outcome === "timeout", "Timeout terminal state was not persisted.");
  assert(timeoutRecord.results[0].agent.timedOut && timeoutRecord.results[0].agent.cleanup.attempted, "Timeout cleanup metadata is missing.");

  const retry = await createFixture("retry", {
    retry: { attempts: 2, delayMs: 1, backoff: "fixed" },
    agentSource: "import { readFile, writeFile } from 'node:fs/promises'; const p='.ariadne/retry-count'; const n=Number(await readFile(p,'utf8').catch(()=>0))+1; await writeFile(p,String(n)); if(n===1) process.exit(7);\n"
  });
  run(binary, ["run", "--quiet"], retry);
  const retryBatch = (await latestBatch(retry)).record;
  assert(retryBatch.batchStatus === "succeeded_with_warnings" && retryBatch.tasks[0].attempts.length === 2, "Installed retry workflow did not preserve two attempts.");

  const dependency = await createFixture("dependency", { agentSource: "if(process.env.ARIADNE_TASK_ID==='task') process.exit(7);\n" });
  await writeFile(path.join(dependency, ".ariadne", "tasks", "dependent.yml"), `${JSON.stringify({ id: "dependent", dependsOn: ["task"], prompt: "Must remain blocked." }, null, 2)}\n`);
  run(binary, ["run", "--quiet"], dependency, 10);
  const dependencyBatch = (await latestBatch(dependency)).record;
  assert(dependencyBatch.tasks.find((task) => task.id === "dependent")?.state === "blocked", "Dependency failure did not block its dependent.");

  const resumable = await createFixture("resume", { agentSource: "import { readFile } from 'node:fs/promises'; if((await readFile('mode.txt','utf8')).trim()==='fail') process.exit(7);\n" });
  await writeFile(path.join(resumable, "mode.txt"), "fail\n");
  run(binary, ["run", "--quiet"], resumable, 10);
  const sourceBatch = (await latestBatch(resumable)).record;
  await writeFile(path.join(resumable, "mode.txt"), "pass\n");
  run(binary, ["resume", sourceBatch.batchId, "--quiet"], resumable);
  const resumedBatch = (await latestBatch(resumable)).record;
  assert(resumedBatch.relation?.kind === "resume" && resumedBatch.tasks[0].attempts.length === 2, "Installed resume did not preserve prior attempts.");
  run(binary, ["rerun", sourceBatch.batchId, "--failed", "--quiet"], resumable);
  const rerunBatch = (await latestBatch(resumable)).record;
  assert(rerunBatch.relation?.kind === "rerun" && rerunBatch.batchStatus === "succeeded", "Installed rerun did not create a successful related batch.");

  let interruption = "skipped-windows";
  if (process.platform !== "win32") {
    const interrupted = await createFixture("interrupted", {
      agentSource: "import { writeFileSync } from 'node:fs'; writeFileSync('agent-started', 'yes'); setInterval(() => {}, 1000);\n",
      timeoutMs: 5_000
    });
    await interruptInstalledRun(installedCli, interrupted);
    const interruptedRecord = (await latestRecord(interrupted)).record;
    const interruptedBatch = (await latestBatch(interrupted)).record;
    assert(interruptedRecord.status === "interrupted" && interruptedRecord.summary.outcome === "interrupted", "Interruption terminal state was not persisted.");
    assert(interruptedRecord.failures.some((failure) => failure.code === "RUN_INTERRUPTED"), "Interruption failure metadata is missing.");
    assert(interruptedBatch.status === "interrupted", "Interrupted batch terminal state was not persisted.");
    interruption = "passed";
  }

  console.log(`packed package flow ok: ${metadata.filename} (${metadata.entryCount} files; installs=npm-local,npm-global,npm-exec,pnpm-local,direct; paths=space,unicode,nested-safe-failure; scenarios=pass,usage,worktree,ignored,review-export,apply,conflict-rollback,discard-idempotency,cleanup-dry-run,cleanup-history,agent,preparation,verification,policy,dirty,timeout,retry,dependency,resume,rerun,tui-pty; interruption=${interruption})`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
