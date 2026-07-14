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

function run(command, args, cwd, expected = 0) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
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

async function createFixture(name, options = {}) {
  const cwd = path.join(temporaryRoot, `fixture-${name}`);
  await mkdir(path.join(cwd, ".ariadne", "tasks"), { recursive: true });
  await writeFile(path.join(cwd, ".gitignore"), ".ariadne/runs/\n.env\nnode_modules/\n");
  await writeFile(path.join(cwd, "target.txt"), "committed\n");
  await writeFile(path.join(cwd, "agent.mjs"), options.agentSource ?? "process.stdin.resume();\n");
  await writeFile(path.join(cwd, ".ariadne", "tasks", "task.yml"), `${JSON.stringify({
    id: "task",
    name: options.taskName ?? name,
    prompt: `Run the deterministic ${name} package fixture.`
  }, null, 2)}\n`);
  await writeFile(path.join(cwd, "ariadne.yml"), `${JSON.stringify({
    version: 2,
    agent: {
      command: { kind: "exec", file: "node", args: ["agent.mjs"] },
      timeout_ms: options.timeoutMs ?? 1_000
    },
    tasks: { directory: ".ariadne/tasks" },
    verification: {
      commands: options.verification ?? [],
      timeout_ms: options.verificationTimeoutMs ?? 1_000
    },
    execution: { termination_grace_ms: 100 },
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
    || /(^|\/)(?:\.ariadne|\.env(?:\..*)?|\.DS_Store|\.idea|\.vscode)(?:\/|$)/.test(name)
    || /\.(?:swp|swo|tmp)$/.test(name)
  );
  assert(forbiddenNames.length === 0, `Package contains development, secret, editor, or temporary files: ${forbiddenNames.join(", ")}`);
  for (const required of ["dist/cli.js", "README.md", "LICENSE", "package.json"]) {
    assert(names.includes(required), `Package is missing ${required}`);
  }

  const installRoot = path.join(temporaryRoot, "install");
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
  for (const file of await packageTextFiles(packageDirectory)) {
    const contents = await readFile(file, "utf8");
    assert(!contents.includes(repoRoot), `Packaged file contains the source-checkout path: ${path.relative(packageDirectory, file)}`);
  }

  const help = run(binary, ["--help"], installRoot);
  assert(help.stdout.includes("Usage: ariadne"), "Installed CLI help output was invalid.");
  for (const command of ["init", "doctor", "run", "list", "report"]) {
    assert(run(binary, [command, "--help"], installRoot).stdout.includes(`Usage: ariadne ${command}`), `Installed ${command} help was invalid.`);
  }
  const version = run(binary, ["--version"], installRoot).stdout.trim();
  assert(version === installedPackage.version, `Installed CLI version ${version} does not match package ${installedPackage.version}`);

  const passing = path.join(temporaryRoot, "fixture-passing");
  await mkdir(passing);
  run("git", ["init", "--quiet"], passing);
  run(binary, ["init"], passing);
  const hostileName = "=2+3 | <script>alert(1)</script><img src=x onerror=alert(1)>";
  await writeFile(path.join(passing, ".ariadne", "tasks", "example.yml"), `${JSON.stringify({ id: "example", name: hostileName, prompt: "Complete the installed-package task." }, null, 2)}\n`);
  run(binary, ["doctor", "--quiet"], passing);
  const terminalRun = run(binary, ["run", "--quiet"], passing);
  assert(terminalRun.stdout.includes("Status: completed") && terminalRun.stdout.includes("Outcome: passed"), `Terminal run contradicted a passing result: ${terminalRun.stdout}`);
  const first = await latestRecord(passing);
  const jsonRun = run(binary, ["run", "--json"], passing);
  const runJson = JSON.parse(jsonRun.stdout);
  assert(runJson.status === "completed" && runJson.outcome === "passed", `JSON run contradicted a passing result: ${jsonRun.stdout}`);
  assert(jsonRun.stderr.includes("Running task: example"), "JSON mode did not route progress to stderr.");
  assert(!jsonRun.stdout.includes(passing), "JSON stdout leaked the absolute fixture path.");
  const second = await latestRecord(passing);
  assert(first.record.runId !== second.record.runId, "Consecutive runs reused a run ID.");
  assert(second.record.summary.outcome === runJson.outcome, "Persisted record and run JSON disagree on outcome.");

  await writeFile(path.join(passing, ".ariadne", "runs", "broken.json"), "{broken");
  const listJsonResult = run(binary, ["list", "--format", "json"], passing);
  const listJson = JSON.parse(listJsonResult.stdout);
  assert(listJsonResult.stderr.includes("broken.json"), "Corrupt history did not produce a stderr warning.");
  assert(listJson[0]?.status === "completed" && listJson[0]?.outcome === "passed" && listJson[0]?.task_name === hostileName, "List JSON contradicts the latest passing record.");
  const listCsv = run(binary, ["list", "--format", "csv", "--quiet"], passing).stdout;
  const listMarkdown = run(binary, ["list", "--format", "markdown", "--quiet"], passing).stdout;
  assert(listCsv.includes("completed,passed") && listCsv.includes("'=2+3"), "CSV output contradicts status or failed formula neutralization.");
  assert(listMarkdown.includes("completed | passed") && listMarkdown.includes("\\|"), "Markdown output contradicts status or failed pipe escaping.");
  const reportResult = run(binary, ["report", "--json", "--quiet"], passing);
  const reportJson = JSON.parse(reportResult.stdout);
  assert(reportJson.runId === second.record.runId && reportJson.status === "completed" && reportJson.outcome === "passed", "Report JSON contradicts latest.json or the persisted record.");
  assert(reportJson.tasks[0]?.name === hostileName && reportJson.tasks[0]?.score === second.record.results[0].score.value, "Report JSON contradicts persisted task data.");
  const htmlPath = path.join(passing, ".ariadne", "runs", second.record.runId, "report.html");
  const html = await readFile(htmlPath, "utf8");
  assert(!html.includes("<script>alert(1)</script>") && !html.includes("onerror=alert(1)>") && html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "HTML report failed hostile-content escaping.");
  assert(html.includes("completed") && html.includes("passed") && html.includes(String(second.record.results[0].score.value)), "HTML report contradicts the canonical status or score.");

  const agentFailure = await createFixture("agent-failure", { agentSource: "process.exit(7);\n" });
  run(binary, ["run", "--quiet"], agentFailure, 10);
  assert((await latestRecord(agentFailure)).record.summary.outcome === "agent_failed", "Agent failure was not persisted.");

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

  let interruption = "skipped-windows";
  if (process.platform !== "win32") {
    const interrupted = await createFixture("interrupted", {
      agentSource: "import { writeFileSync } from 'node:fs'; writeFileSync('agent-started', 'yes'); setInterval(() => {}, 1000);\n",
      timeoutMs: 5_000
    });
    await interruptInstalledRun(installedCli, interrupted);
    const interruptedRecord = (await latestRecord(interrupted)).record;
    assert(interruptedRecord.status === "interrupted" && interruptedRecord.summary.outcome === "interrupted", "Interruption terminal state was not persisted.");
    assert(interruptedRecord.failures.some((failure) => failure.code === "RUN_INTERRUPTED"), "Interruption failure metadata is missing.");
    interruption = "passed";
  }

  console.log(`packed package flow ok: ${metadata.filename} (${metadata.entryCount} files; scenarios=pass,agent,verification,policy,dirty,timeout; interruption=${interruption})`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
