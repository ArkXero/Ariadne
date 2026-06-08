import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");

function run(command, args, cwd, expectedExitCode = 0, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env
    }
  });

  if (result.status !== expectedExitCode) {
    throw new Error([
      `Command failed: ${command} ${args.join(" ")}`,
      `cwd: ${cwd}`,
      `expected exit: ${expectedExitCode}`,
      `actual exit: ${result.status}`,
      "stdout:",
      result.stdout,
      "stderr:",
      result.stderr
    ].join("\n"));
  }

  return result;
}

async function assertGlobalLinkFlow() {
  const pnpmHome = await mkdtemp(path.join(os.tmpdir(), "ariadne-pnpm-home-"));
  const env = {
    PNPM_HOME: pnpmHome,
    PATH: `${pnpmHome}${path.delimiter}${process.env.PATH ?? ""}`
  };

  try {
    run("pnpm", ["link", "--global"], repoRoot, 0, env);
    const helpResult = run("ariadne", ["--help"], repoRoot, 0, env);

    if (!helpResult.stdout.includes("Usage: ariadne [options] [command]")) {
      throw new Error(`Expected linked Ariadne usage output, got ${helpResult.stdout}`);
    }

    console.log(`global link flow ok: ${pnpmHome}`);
  } finally {
    await rm(pnpmHome, { recursive: true, force: true });
  }
}

async function latestRunJson(cwd) {
  const runsDir = path.join(cwd, ".ariadne", "runs");
  const files = (await readdir(runsDir))
    .filter((file) => file.endsWith(".json") && file !== "runs.json")
    .sort();

  if (files.length === 0) {
    throw new Error(`No run JSON files found in ${runsDir}`);
  }

  return path.join(runsDir, files.at(-1));
}

async function assertPassingFlow() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ariadne-pass-"));

  run("git", ["init"], cwd);
  run(process.execPath, [cliPath, "--help"], cwd);
  run(process.execPath, [cliPath, "-h"], cwd);
  run(process.execPath, [cliPath, "--", "--help"], cwd);
  run(process.execPath, [cliPath, "init"], cwd);
  run("git", ["check-ignore", ".ariadne/runs", ".ariadne/tasks/example.yml", "ariadne.yml"], cwd);
  run(process.execPath, [cliPath, "doctor"], cwd);
  run(process.execPath, [cliPath, "run"], cwd);
  const listResult = run(process.execPath, [cliPath, "list"], cwd);
  const wideListResult = run(process.execPath, [cliPath, "list", "--wide"], cwd);
  run(process.execPath, [cliPath, "list", "--csv"], cwd);
  run(process.execPath, [cliPath, "list", "--md"], cwd);
  run(process.execPath, [cliPath, "list", "--json"], cwd);
  run(process.execPath, [cliPath, "report"], cwd);

  const runPath = await latestRunJson(cwd);
  const runJson = JSON.parse(await readFile(runPath, "utf8"));
  const runCsv = await readFile(path.join(cwd, ".ariadne", "runs", "runs.csv"), "utf8");
  const runMarkdown = await readFile(path.join(cwd, ".ariadne", "runs", "runs.md"), "utf8");
  const runListJson = JSON.parse(await readFile(path.join(cwd, ".ariadne", "runs", "runs.json"), "utf8"));

  if (runJson.summary.total !== 1 || runJson.summary.failed !== 0) {
    throw new Error(`Expected passing smoke run, got ${JSON.stringify(runJson.summary)}`);
  }
  if (!listResult.stdout.includes("Run ID") || !listResult.stdout.includes("example") || listResult.stdout.includes(".ariadne/runs/")) {
    throw new Error(`Expected compact list output, got ${listResult.stdout}`);
  }
  if (!wideListResult.stdout.includes("Task Name") || !wideListResult.stdout.includes(".ariadne/runs/")) {
    throw new Error(`Expected wide list output, got ${wideListResult.stdout}`);
  }
  if (!runCsv.startsWith("started_at,status,task_id,task_name,duration_ms,duration,path\n") || !runCsv.includes(",passed,")) {
    throw new Error(`Expected list CSV to include passing run, got ${runCsv}`);
  }
  if (!runMarkdown.startsWith("| started_at | status | task_id | task_name | duration_ms | duration | path |")) {
    throw new Error(`Expected Markdown list export, got ${runMarkdown}`);
  }
  if (!Array.isArray(runListJson) || runListJson[0]?.task_id !== "example") {
    throw new Error(`Expected JSON list export, got ${JSON.stringify(runListJson)}`);
  }

  console.log(`passing flow ok: ${cwd}`);
}

async function assertForbiddenFileFailure() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ariadne-forbidden-"));

  run("git", ["init"], cwd);
  run(process.execPath, [cliPath, "init"], cwd);

  await writeFile(path.join(cwd, ".gitignore"), ".env\n", { flag: "a" });
  const configPath = path.join(cwd, "ariadne.yml");
  const config = await readFile(configPath, "utf8");
  await writeFile(configPath, config.replace('command: "cat"', 'command: "sh -c \'cat > .env\'"'));

  run(process.execPath, [cliPath, "run"], cwd, 1);
  run(process.execPath, [cliPath, "report"], cwd);

  const runPath = await latestRunJson(cwd);
  const runJson = JSON.parse(await readFile(runPath, "utf8"));
  const forbiddenChanges = runJson.results?.[0]?.trace?.forbiddenFileChanges ?? [];

  if (runJson.summary.failed !== 1 || !forbiddenChanges.includes(".env")) {
    throw new Error(`Expected forbidden .env failure, got ${JSON.stringify(runJson.summary)}`);
  }

  console.log(`forbidden file flow ok: ${cwd}`);
}

await assertGlobalLinkFlow();
await assertPassingFlow();
await assertForbiddenFileFailure();
