import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");
const temporaryDirectories = [];

function run(command, args, cwd, expected = 0, env = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  if (result.status !== expected) {
    throw new Error([`Command failed: ${command} ${args.join(" ")}`, `cwd: ${cwd}`, `expected ${expected}, got ${result.status}`, "stdout:", result.stdout, "stderr:", result.stderr].join("\n"));
  }
  return result;
}

function runPnpm(args, cwd, expected = 0, env = {}) {
  const requestedVersion = process.env.ARIADNE_SMOKE_PNPM_VERSION;
  return requestedVersion
    ? run("corepack", [`pnpm@${requestedVersion}`, "--pm-on-fail=ignore", ...args], cwd, expected, env)
    : run("pnpm", args, cwd, expected, env);
}

async function temporary(prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function latestManifest(cwd) {
  const pointer = JSON.parse(await readFile(path.join(cwd, ".ariadne", "runs", "latest.json"), "utf8"));
  return path.join(cwd, ".ariadne", "runs", pointer.manifest);
}

try {
  const pnpmHome = await temporary("ariadne-pnpm-home-");
  const linkedSource = await temporary("ariadne-link-source-");
  for (const entry of ["package.json", "README.md", "LICENSE", "dist"]) {
    await cp(path.join(repoRoot, entry), path.join(linkedSource, entry), { recursive: true });
  }
  await symlink(
    path.join(repoRoot, "node_modules"),
    path.join(linkedSource, "node_modules"),
    process.platform === "win32" ? "junction" : "dir"
  );
  // pnpm 10 links binaries directly under PNPM_HOME; pnpm 11 uses PNPM_HOME/bin.
  // Put both locations on PATH so this isolated smoke test works across both layouts.
  const linkedBin = path.join(pnpmHome, "bin");
  const linkedEnv = {
    PNPM_HOME: pnpmHome,
    PATH: [linkedBin, pnpmHome, process.env.PATH ?? ""].join(path.delimiter)
  };
  const pnpmVersion = runPnpm(["--version"], repoRoot, 0, linkedEnv).stdout.trim();
  const pnpmMajor = Number.parseInt(pnpmVersion.split(".")[0] ?? "0", 10);
  const globalInstallArgs = pnpmMajor >= 11
    ? ["add", "--global", "."]
    : ["link"];
  runPnpm(globalInstallArgs, linkedSource, 0, linkedEnv);
  const linkedHelp = run("ariadne", ["--help"], linkedSource, 0, linkedEnv);
  if (!linkedHelp.stdout.includes("Usage: ariadne")) throw new Error("Global link help output was invalid.");
  console.log(`global binary flow ok: pnpm ${pnpmVersion}, ${pnpmHome}`);

  const passing = await temporary("ariadne-pass-");
  run("git", ["init", "--quiet"], passing);
  run(process.execPath, [cliPath, "--help"], passing);
  run(process.execPath, [cliPath, "-h"], passing);
  run(process.execPath, [cliPath, "--", "--help"], passing);
  run(process.execPath, [cliPath, "tui", "--help"], passing);
  const tuiRefusal = run(process.execPath, [cliPath, "tui"], passing, 2);
  if (tuiRefusal.stdout !== "" || tuiRefusal.stderr.includes("\u001B")) throw new Error("Non-TTY TUI refusal emitted stdout or ANSI.");
  run(process.execPath, [cliPath, "init"], passing);
  run(process.execPath, [cliPath, "doctor", "--quiet"], passing);
  run(process.execPath, [cliPath, "plan", "--all", "--json"], passing);
  run(process.execPath, [cliPath, "run", "--quiet"], passing);
  const jsonList = run(process.execPath, [cliPath, "list", "--json", "--quiet"], passing);
  JSON.parse(jsonList.stdout);
  run(process.execPath, [cliPath, "list", "--format", "wide", "--quiet"], passing);
  run(process.execPath, [cliPath, "list", "--format", "csv", "--quiet"], passing);
  run(process.execPath, [cliPath, "list", "--format", "markdown", "--quiet"], passing);
  run(process.execPath, [cliPath, "report", "--quiet"], passing);
  const passingRecord = JSON.parse(await readFile(await latestManifest(passing), "utf8"));
  if (passingRecord.schemaVersion !== 4 || passingRecord.summary.outcome !== "passed" || !passingRecord.workflow?.batchId) throw new Error(`Passing run was invalid: ${JSON.stringify(passingRecord.summary)}`);
  console.log(`passing flow ok: ${passing}`);

  const forbidden = await temporary("ariadne-forbidden-");
  run("git", ["init", "--quiet"], forbidden);
  run(process.execPath, [cliPath, "init"], forbidden);
  await writeFile(path.join(forbidden, ".gitignore"), ".env\n", { flag: "a" });
  await writeFile(path.join(forbidden, "agent.mjs"), "import { writeFile } from 'node:fs/promises'; await writeFile('.env', 'SAMPLE=true\\n');\n");
  const configPath = path.join(forbidden, "ariadne.yml");
  const config = parse(await readFile(configPath, "utf8"));
  config.agent.command = { kind: "exec", file: "node", args: ["agent.mjs"] };
  await writeFile(configPath, stringify(config));
  run(process.execPath, [cliPath, "run", "--quiet"], forbidden, 13);
  const forbiddenRecord = JSON.parse(await readFile(await latestManifest(forbidden), "utf8"));
  const evidence = forbiddenRecord.results?.[0]?.trace?.forbiddenFileChanges ?? [];
  if (!evidence.some((item) => item.path === ".env")) throw new Error(`Forbidden .env evidence missing: ${JSON.stringify(evidence)}`);
  console.log(`forbidden file flow ok: ${forbidden}`);
} finally {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
}
