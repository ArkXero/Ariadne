import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repoRoot, "dist", "cli.js");
const fixture = await mkdtemp(path.join(os.tmpdir(), "ariadne-tui-dogfood-"));

function run(args, expected = 0, stdio = "pipe") {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: fixture, encoding: "utf8", stdio, env: { ...process.env } });
  if (result.status !== expected) throw new Error(`Command failed (${result.status}): ariadne ${args.join(" ")}\n${result.stderr ?? ""}`);
  return result;
}

try {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("pnpm dogfood:tui requires a real interactive terminal.");
  spawnSync("git", ["init", "--quiet"], { cwd: fixture, stdio: "inherit" });
  run(["init"]);
  run(["run", "--quiet"]);

  const configPath = path.join(fixture, "ariadne.yml");
  const config = parse(await readFile(configPath, "utf8"));
  config.agent.command = {
    kind: "exec",
    file: "node",
    args: ["agent.mjs"]
  };
  config.agent.timeout_ms = 1500;
  config.execution.concurrency = 2;
  config.execution.termination_grace_ms = 100;
  await writeFile(configPath, stringify(config));
  await writeFile(path.join(fixture, "agent.mjs"), `
import { mkdir, readFile, writeFile } from "node:fs/promises";
const id = process.env.ARIADNE_TASK_ID;
await mkdir(".ariadne/control", { recursive: true });
if (id === "retry-success") {
  const file = ".ariadne/control/retry-count";
  const count = Number(await readFile(file, "utf8").catch(() => "0")) + 1;
  await writeFile(file, String(count));
  if (count === 1) process.exit(7);
}
if (id === "fail-root" || id === "retry-exhaust") process.exit(7);
if (id === "policy-fail") await writeFile(".env", "DOGFOOD_SECRET=must-not-survive\n");
if (id === "hostile-output") {
  process.stdout.write("\\u001b]8;;https://example.invalid\\u0007link\\u001b]8;;\\u0007\\n");
  for (let index = 0; index < 1200; index += 1) process.stderr.write("hostile-" + index + "-" + "X".repeat(200) + "\\n");
}
if (id === "partial-output") {
  const glyph = Buffer.from("split-😀-character");
  process.stdout.write(glyph.subarray(0, 8));
  await new Promise((resolve) => setTimeout(resolve, 100));
  process.stdout.write(glyph.subarray(8));
}
if (id === "timeout") setInterval(() => console.log("waiting for timeout"), 100);
if (id === "cancellation-resistant") {
  process.on("SIGTERM", () => {});
  setInterval(() => console.log("still running"), 100);
}
if (id === "detached-completion") await new Promise((resolve) => setTimeout(resolve, 3000));
if (id.startsWith("concurrent")) await new Promise((resolve) => setTimeout(resolve, 350));
console.log("completed " + id);
`);
  const taskRoot = path.join(fixture, ".ariadne", "tasks");
  config.checks.forbidden_files = [".env"];
  await writeFile(configPath, stringify(config));
  const writeTask = (name, value) => writeFile(path.join(taskRoot, `${name}.yml`), stringify({ id: name, name: value.name, prompt: `Run ${name}.`, workspaceMode: value.workspaceMode ?? "mutable", dependsOn: value.dependsOn ?? [], retry: value.retry ?? { attempts: 1, delayMs: 0, backoff: "fixed" }, metadata: { description: value.description, group: value.group ?? "dogfood", tags: value.tags ?? ["tui"] }, ...(value.verify ? { verify: value.verify } : {}) }));
  await Promise.all([
    writeTask("example", { name: "Successful workflow", description: "Fast successful baseline." }),
    writeTask("concurrent-a", { name: "Concurrent reader A", description: "Overlaps safely in shared mode.", workspaceMode: "read-only" }),
    writeTask("concurrent-b", { name: "Concurrent reader B", description: "Overlaps safely in shared mode.", workspaceMode: "read-only" }),
    writeTask("retry-success", { name: "Retry then succeed", description: "Fails once, enters retry_wait, then succeeds.", retry: { attempts: 2, delayMs: 1000, backoff: "fixed" } }),
    writeTask("retry-exhaust", { name: "Retry exhaustion", description: "Fails twice and exhausts its retry policy.", retry: { attempts: 2, delayMs: 500, backoff: "fixed" } }),
    writeTask("chain-root", { name: "Successful chain root", description: "First level of a successful dependency chain." }),
    writeTask("chain-child", { name: "Successful chain child", description: "Runs after chain-root succeeds.", dependsOn: ["chain-root"] }),
    writeTask("fail-root", { name: "Failing root", description: "Creates a failed branch." }),
    writeTask("blocked-child", { name: "Blocked descendant", description: "Never launches after fail-root.", dependsOn: ["fail-root"] }),
    writeTask("verification-fail", { name: "Verification failure", description: "Agent passes and task verification fails.", verify: [{ kind: "exec", file: "node", args: ["-e", "console.error('verification failed'); process.exit(2)"] }] }),
    writeTask("policy-fail", { name: "Forbidden-file policy failure", description: "Writes a protected .env file for policy rendering." }),
    writeTask("hostile-output", { name: "Hostile high-volume output", description: "Exercises sanitization, bounds, and truncation." }),
    writeTask("partial-output", { name: "Partial UTF-8 output", description: "Splits a multi-byte character and omits the final newline." }),
    writeTask("timeout", { name: "Agent timeout", description: "Runs until the configured agent timeout terminates it." }),
    writeTask("detached-completion", { name: "Detached completion", description: "Runs long enough to detach, reopen, or leave headless." }),
    writeTask("cancellation-resistant", { name: "Cancellation resistance", description: "Ignores TERM until Ariadne escalates." })
  ]);
  spawnSync("git", ["add", "."], { cwd: fixture, stdio: "inherit" });
  const committed = spawnSync("git", ["-c", "user.name=Ariadne Dogfood", "-c", "user.email=dogfood@example.test", "commit", "--quiet", "-m", "operational tui fixture"], { cwd: fixture, stdio: "inherit" });
  if (committed.status !== 0) throw new Error("Could not commit the operational TUI fixture.");
  await writeFile(path.join(fixture, "dirty-note.txt"), "Intentional dirty-base planning warning.\n");
  run(["run", "example", "--quiet"]);
  run(["run", "retry-success", "--quiet"]);
  await rm(path.join(fixture, ".ariadne", "control", "retry-count"), { force: true });
  run(["run", "blocked-child", "--quiet"], 10);

  await writeFile(path.join(fixture, ".ariadne", "runs", "corrupt.json"), "{broken");
  await writeFile(path.join(fixture, ".ariadne", "runs", "future.json"), JSON.stringify({ schemaVersion: 999, startedAt: new Date().toISOString() }));

  process.stderr.write(`\nDisposable operational TUI fixture: ${fixture}\nPreserve full-screen fill, Coral frames, and bold Cyan > focus while resizing through 120x30, 80x24, 50x20, and <40x12.\nUse p to exercise success, chain-child, concurrent-a+b, retry-success/exhaustion, blocked-child, verification/policy failure, hostile/partial output, timeout, detached-completion, cancellation-resistant, dirty-base acknowledgement, and worktree isolation. Exercise options, launch confirmation, live process/stream switching, Esc dashboard detach/reopen, c confirmation/abort/confirm, history R/f/B/A previews, normal q, confirmed headless q, Ctrl-C, SIGINT, and SIGTERM restoration.\n\n`);
  run(["tui"], 0, "inherit");
} finally {
  await rm(fixture, { recursive: true, force: true });
}
