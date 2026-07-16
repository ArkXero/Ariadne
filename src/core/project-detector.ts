import path from "node:path";
import { constants } from "node:fs";
import fs from "fs-extra";
import { execa } from "execa";
import type { ProcessSpec } from "../types/index.js";

const SCRIPT_PRIORITY = ["check", "test", "build", "lint", "typecheck", "dev"];
const VALIDATION_PRIORITY = ["check", "test", "typecheck", "lint", "build"];

export interface DetectedCommand {
  id: string;
  script: string;
  display: string;
  process: ProcessSpec;
  recommended: boolean;
}

export interface DetectedAgent {
  id: "codex" | "claude";
  label: string;
  process: ProcessSpec;
}

export interface RepositoryDetection {
  projectType: string;
  packageManager?: string;
  commands: DetectedCommand[];
  validationCommand?: DetectedCommand;
  agents: DetectedAgent[];
  git: {
    available: boolean;
    hasHead: boolean;
    worktreeIsolation: boolean;
  };
  warnings: string[];
}

interface PackageManifest {
  packageManager?: unknown;
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

async function executableExists(cwd: string, executable: string): Promise<boolean> {
  if (executable.includes("/") || executable.includes("\\")) {
    const resolved = path.isAbsolute(executable) ? executable : path.resolve(cwd, executable);
    return fs.access(resolved, constants.X_OK).then(() => true, () => false);
  }
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      if (await fs.access(path.join(directory, `${executable}${extension}`), constants.X_OK).then(() => true, () => false)) return true;
    }
  }
  return false;
}

async function readPackageManifest(cwd: string, warnings: string[]): Promise<PackageManifest | undefined> {
  const manifestPath = path.join(cwd, "package.json");
  if (!(await fs.pathExists(manifestPath))) return undefined;
  try {
    return await fs.readJson(manifestPath) as PackageManifest;
  } catch (error) {
    warnings.push(`Could not inspect package.json: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function packageManagerFromField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^(pnpm|npm|yarn|bun)(?:@|$)/);
  return match?.[1];
}

async function detectPackageManager(cwd: string, manifest: PackageManifest | undefined): Promise<string | undefined> {
  const declared = packageManagerFromField(manifest?.packageManager);
  if (declared) return declared;
  for (const [file, manager] of [
    ["pnpm-lock.yaml", "pnpm"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"]
  ] as const) {
    if (await fs.pathExists(path.join(cwd, file))) return manager;
  }
  return manifest ? "npm" : undefined;
}

function processForScript(packageManager: string, script: string): ProcessSpec {
  return {
    kind: "exec",
    file: packageManager,
    args: packageManager === "npm" ? ["run", script] : [script]
  };
}

function displayForScript(packageManager: string, script: string): string {
  return packageManager === "npm" ? `npm run ${script}` : `${packageManager} ${script}`;
}

async function detectProjectType(cwd: string, manifest: PackageManifest | undefined): Promise<string> {
  const allDependencies = { ...manifest?.dependencies, ...manifest?.devDependencies };
  if (await fs.pathExists(path.join(cwd, "tsconfig.json")) || typeof allDependencies.typescript === "string") return "TypeScript project";
  if (manifest) return "Node.js project";
  if (await fs.pathExists(path.join(cwd, "pyproject.toml")) || await fs.pathExists(path.join(cwd, "requirements.txt"))) return "Python project";
  if (await fs.pathExists(path.join(cwd, "Cargo.toml"))) return "Rust project";
  if (await fs.pathExists(path.join(cwd, "go.mod"))) return "Go project";
  return "generic project";
}

async function detectGit(cwd: string): Promise<RepositoryDetection["git"]> {
  try {
    const inside = await execa("git", ["rev-parse", "--is-inside-work-tree"], { cwd, reject: false });
    if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") return { available: false, hasHead: false, worktreeIsolation: false };
    const head = await execa("git", ["rev-parse", "--verify", "HEAD"], { cwd, reject: false });
    const hasHead = head.exitCode === 0;
    return { available: true, hasHead, worktreeIsolation: hasHead };
  } catch {
    return { available: false, hasHead: false, worktreeIsolation: false };
  }
}

export async function detectRepository(cwd: string): Promise<RepositoryDetection> {
  const warnings: string[] = [];
  const manifest = await readPackageManifest(cwd, warnings);
  const packageManager = await detectPackageManager(cwd, manifest);
  if (packageManager && !(await executableExists(cwd, packageManager))) warnings.push(`${packageManager} is declared by the project but its executable was not found on PATH.`);
  const scripts = Object.entries(manifest?.scripts ?? {})
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name]) => name);
  const orderedScripts = [...scripts].sort((left, right) => {
    const leftRank = SCRIPT_PRIORITY.indexOf(left);
    const rightRank = SCRIPT_PRIORITY.indexOf(right);
    if (leftRank !== -1 || rightRank !== -1) return (leftRank === -1 ? SCRIPT_PRIORITY.length : leftRank) - (rightRank === -1 ? SCRIPT_PRIORITY.length : rightRank);
    return left.localeCompare(right);
  });
  const commands = packageManager
    ? orderedScripts.map((script) => ({
        id: script,
        script,
        display: displayForScript(packageManager, script),
        process: processForScript(packageManager, script),
        recommended: VALIDATION_PRIORITY.includes(script)
      }))
    : [];
  const validationCommand = VALIDATION_PRIORITY
    .map((name) => commands.find((command) => command.script === name))
    .find((command): command is DetectedCommand => Boolean(command));
  const agents: DetectedAgent[] = [];
  if (await executableExists(cwd, "codex")) {
    agents.push({ id: "codex", label: "Codex", process: { kind: "exec", file: "codex", args: ["exec", "--sandbox", "workspace-write", "-"] } });
  }
  if (await executableExists(cwd, "claude")) {
    agents.push({ id: "claude", label: "Claude Code", process: { kind: "exec", file: "claude", args: ["-p"] } });
  }
  return {
    projectType: await detectProjectType(cwd, manifest),
    ...(packageManager ? { packageManager } : {}),
    commands,
    ...(validationCommand ? { validationCommand } : {}),
    agents,
    git: await detectGit(cwd),
    warnings
  };
}
