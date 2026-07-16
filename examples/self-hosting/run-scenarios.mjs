import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repositoryRoot, "dist", "cli.js");
const temporaryRoots = [];

function run(command, args, cwd, expected = 0) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  if (result.status !== expected) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}; expected ${expected}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

async function scenario(name, agentSource, expectedExit, options = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), `ariadne-self-${name}-`));
  temporaryRoots.push(cwd);
  await mkdir(path.join(cwd, ".ariadne", "tasks"), { recursive: true });
  await writeFile(path.join(cwd, "target.txt"), "committed\n");
  await writeFile(path.join(cwd, ".gitignore"), ".ariadne/runs/\n.ariadne/batches/\n.ariadne/worktrees/\n.ariadne/promotions/\n.env\n");
  await writeFile(path.join(cwd, "agent.mjs"), agentSource);
  await writeFile(path.join(cwd, ".ariadne", "tasks", `${name}.yml`), `id: ${name}\nname: ${name}\ndependsOn: []\nworkspaceMode: mutable\nretry:\n  attempts: 1\n  delayMs: 0\n  backoff: fixed\nprompt: Run the deterministic ${name} fixture.\n`);
  await writeFile(path.join(cwd, "ariadne.yml"), `version: 4
agent:
  command:
    kind: exec
    file: node
    args: [agent.mjs]
  timeout_ms: ${options.timeout ?? 1000}
tasks:
  directory: .ariadne/tasks
verification:
  commands: []
  timeout_ms: 1000
execution:
  termination_grace_ms: 100
  concurrency: 1
  failure_mode: continue
  isolation: ${options.isolation ?? "shared"}
  worktree:
    retention: on-failure
    preparation: {commands: [], timeout_ms: 1000}
checks:
  forbidden_files: [.env]
  forbidden_commands: []
  max_changed_files: ${options.maxFiles ?? 10}
  max_diff_lines: 100
`);
  run("git", ["init", "--quiet"], cwd);
  run("git", ["add", "."], cwd);
  run("git", ["-c", "user.name=Ariadne Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "fixture"], cwd);
  if (options.dirtyBaseline) await writeFile(path.join(cwd, "target.txt"), "preexisting dirt\n");
  run(process.execPath, [cli, "doctor", "--quiet"], cwd);
  const plan = JSON.parse(run(process.execPath, [cli, "plan", "--all", "--json"], cwd).stdout);
  if (plan.order?.join(",") !== name) throw new Error(`Unexpected plan for ${name}: ${JSON.stringify(plan)}`);
  run(process.execPath, [cli, "run", "--quiet", ...(options.dirtyBaseline && options.isolation === "worktree" ? ["--allow-dirty-base"] : [])], cwd, expectedExit);
  run(process.execPath, [cli, "report", "--quiet"], cwd);
  const pointer = JSON.parse(await readFile(path.join(cwd, ".ariadne", "runs", "latest.json"), "utf8"));
  const report = path.join(cwd, ".ariadne", "runs", path.dirname(pointer.manifest), "report.html");
  await readFile(report, "utf8");
  const batchPointer = JSON.parse(await readFile(path.join(cwd, ".ariadne", "batches", "latest.json"), "utf8"));
  await readFile(path.join(cwd, ".ariadne", "batches", batchPointer.manifest), "utf8");
  await readFile(path.join(cwd, ".ariadne", "batches", path.dirname(batchPointer.manifest), "report.html"), "utf8");
  process.stdout.write(`ok ${name}\n`);
}

try {
  await scenario("validation", "process.stdin.resume();\n", 0);
  await scenario("isolated-fix", "import { appendFile } from 'node:fs/promises'; process.stdin.resume(); await appendFile('target.txt', 'fixed\\n');\n", 0, { isolation: "worktree" });
  await scenario("change-limit", "import { writeFile } from 'node:fs/promises'; process.stdin.resume(); await writeFile('one.txt', '1'); await writeFile('two.txt', '2');\n", 13, { maxFiles: 1 });
  await scenario("forbidden-file", "import { writeFile } from 'node:fs/promises'; process.stdin.resume(); await writeFile('.env', 'fixture=true\\n');\n", 13);
  await scenario("timeout", "setInterval(() => {}, 1000);\n", 11, { timeout: 25 });
  await scenario("dirty-baseline", "import { appendFile } from 'node:fs/promises'; process.stdin.resume(); await appendFile('target.txt', 'agent edit\\n');\n", 0, { dirtyBaseline: true });
} finally {
  await Promise.all(temporaryRoots.map((cwd) => rm(cwd, { recursive: true, force: true })));
}
