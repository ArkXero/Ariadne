import os from "node:os";
import path from "node:path";
import process from "node:process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = process.env.ARIADNE_TUI_CLI ? path.resolve(process.env.ARIADNE_TUI_CLI) : path.join(repoRoot, "dist", "cli.js");
const driver = path.join(repoRoot, "scripts", "tui-pty-driver.py");
const fixture = await mkdtemp(path.join(os.tmpdir(), "ariadne-tui-pty-"));
const reviewFixture = await mkdtemp(path.join(os.tmpdir(), "ariadne-tui-review-pty-"));

function initialize(cwd) {
  const git = spawnSync("git", ["init", "--quiet"], { cwd, encoding: "utf8" });
  if (git.status !== 0) throw new Error(git.stderr || "git init failed");
  const initialized = spawnSync(process.execPath, [cli, "init"], { cwd, encoding: "utf8" });
  if (initialized.status !== 0) throw new Error(initialized.stderr || "ariadne init failed");
}

async function configureSlowFixture() {
  const configPath = path.join(fixture, "ariadne.yml");
  const config = parse(await readFile(configPath, "utf8"));
  config.agent.command = {
    kind: "exec",
    file: "node",
    args: ["-e", "process.stdin.resume(); let n=0; const timer=setInterval(()=>console.log('pty live '+(++n)),100); process.on('SIGTERM',()=>{clearInterval(timer)}); setTimeout(()=>{clearInterval(timer)},30000)"]
  };
  config.execution.termination_grace_ms = 100;
  config.verification.commands = [{ kind: "exec", file: "node", args: ["-e", "console.log('pty verification')"] }];
  await writeFile(configPath, stringify(config));
  const taskPath = path.join(fixture, ".ariadne", "tasks", "example.yml");
  const task = parse(await readFile(taskPath, "utf8"));
  task.name = "PTY operational workflow";
  task.metadata = { description: "Exercises planning, live output, detach, reopen, and cancellation.", group: "smoke", tags: ["pty", "operational"] };
  await writeFile(taskPath, stringify(task));
}

async function configureReviewFixture() {
  const configPath = path.join(reviewFixture, "ariadne.yml");
  const config = parse(await readFile(configPath, "utf8"));
  config.agent.command = { kind: "exec", file: "node", args: ["agent.mjs"] };
  config.execution.isolation = "worktree";
  config.execution.worktree.retention = "always";
  config.verification.commands = [];
  await writeFile(configPath, stringify(config));
  await writeFile(path.join(reviewFixture, "target.txt"), "before\n");
  await writeFile(path.join(reviewFixture, "agent.mjs"), "import { appendFile } from 'node:fs/promises'; process.stdin.resume(); await appendFile('target.txt', 'reviewed\\n');\n");
  const added = spawnSync("git", ["add", "."], { cwd: reviewFixture, encoding: "utf8" });
  if (added.status !== 0) throw new Error(added.stderr || "review git add failed");
  const committed = spawnSync("git", ["-c", "user.name=Ariadne PTY", "-c", "user.email=pty@example.test", "commit", "--quiet", "-m", "review fixture"], { cwd: reviewFixture, encoding: "utf8" });
  if (committed.status !== 0) throw new Error(committed.stderr || "review git commit failed");
  const ran = spawnSync(process.execPath, [cli, "run", "--quiet"], { cwd: reviewFixture, encoding: "utf8", timeout: 20_000 });
  if (ran.status !== 0) throw new Error(`${ran.stdout}\n${ran.stderr}`);
}

try {
  if (process.platform === "win32") {
    process.stdout.write("TUI PTY smoke skipped: the POSIX PTY facility is unavailable. Simulated terminal coverage remains active.\n");
  } else {
    const python = spawnSync("python3", ["--version"], { encoding: "utf8" });
    if (python.status !== 0) {
      process.stdout.write("TUI PTY smoke skipped: python3 is unavailable for the POSIX pty driver. Simulated terminal coverage remains active.\n");
    } else {
      initialize(fixture);
      await configureSlowFixture();
      const result = spawnSync("python3", [driver, fixture, process.execPath, cli, "tui"], {
        cwd: fixture,
        encoding: "utf8",
        timeout: 45_000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, TERM: "xterm-256color", LANG: "en_US.UTF-8", NO_COLOR: "1" }
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`TUI PTY driver failed (${result.status ?? result.signal}).\n${result.stdout}\n${result.stderr}`);
      process.stdout.write(result.stdout || "TUI PTY smoke passed.\n");

      initialize(reviewFixture);
      await configureReviewFixture();
      const review = spawnSync("python3", [driver, reviewFixture, process.execPath, cli, "tui"], {
        cwd: reviewFixture,
        encoding: "utf8",
        timeout: 45_000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, TERM: "xterm-256color", LANG: "en_US.UTF-8", NO_COLOR: "1", ARIADNE_PTY_MODE: "review" }
      });
      if (review.error) throw review.error;
      if (review.status !== 0) throw new Error(`TUI PTY review driver failed (${review.status ?? review.signal}).\n${review.stdout}\n${review.stderr}`);
      process.stdout.write(review.stdout || "TUI PTY review smoke passed.\n");
    }
  }
} finally {
  await rm(fixture, { recursive: true, force: true });
  await rm(reviewFixture, { recursive: true, force: true });
}
