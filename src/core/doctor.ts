import path from "node:path";
import { constants } from "node:fs";
import fs from "fs-extra";
import { loadConfig } from "./config.js";
import { loadTasks } from "./task-loader.js";

export type DoctorCheckLevel = "pass" | "warning" | "error";

export interface DoctorCheck {
  name: string;
  level: DoctorCheckLevel;
  message: string;
  suggestion?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  passed: boolean;
  errors: number;
  warnings: number;
}

const PACKAGE_MANAGER_COMMANDS = new Set(["npm", "pnpm", "yarn", "bun"]);
const PNPM_BUILT_INS = new Set([
  "add", "audit", "config", "create", "deploy", "dlx", "exec", "fetch", "import",
  "init", "install", "link", "list", "outdated", "pack", "patch", "prune", "publish",
  "rebuild", "remove", "root", "setup", "store", "unlink", "update", "why"
]);
const YARN_BUILT_INS = new Set([
  "add", "bin", "cache", "config", "create", "dlx", "exec", "help", "import", "info",
  "init", "install", "link", "node", "npm", "pack", "plugin", "remove", "set", "unlink",
  "up", "why", "workspace", "workspaces"
]);

function check(name: string, level: DoctorCheckLevel, message: string, suggestion?: string): DoctorCheck {
  return { name, level, message, suggestion };
}

function tokenize(command: string): string[] {
  return (command.match(/(?:[^\s"'\\]+|\\.|"(?:\\.|[^"])*"|'[^']*')+/g) ?? [])
    .map((token) => token.replace(/^(['"])(.*)\1$/, "$2"));
}

function executableFromCommand(command: string): string | undefined {
  const tokens = tokenize(command);
  let index = 0;

  while (tokens[index]?.includes("=") && !tokens[index]?.startsWith("=")) {
    index += 1;
  }

  if (tokens[index] === "env") {
    index += 1;
    while (tokens[index]?.includes("=") && !tokens[index]?.startsWith("=")) {
      index += 1;
    }
  }

  return tokens[index];
}

async function executableExists(cwd: string, executable: string): Promise<boolean> {
  if (executable.includes("/") || executable.includes("\\")) {
    const resolved = path.resolve(cwd, executable);
    return fs.access(resolved, constants.X_OK).then(() => true, () => false);
  }

  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];

  for (const entry of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(entry, `${executable}${extension}`);
      if (await fs.access(candidate, constants.X_OK).then(() => true, () => false)) {
        return true;
      }
    }
  }

  return false;
}

function packageScriptFromCommand(command: string): { manager: string; script: string } | undefined {
  const tokens = tokenize(command);
  const managerIndex = tokens.findIndex((token) => PACKAGE_MANAGER_COMMANDS.has(path.basename(token)));
  if (managerIndex === -1) {
    return undefined;
  }

  const manager = path.basename(tokens[managerIndex]);
  const args = tokens.slice(managerIndex + 1);
  if (args[0] === "run" && args[1] && !args[1].startsWith("-")) {
    return { manager, script: args[1] };
  }

  if (manager === "pnpm" && args[0] && !args[0].startsWith("-") && !PNPM_BUILT_INS.has(args[0])) {
    return { manager, script: args[0] };
  }

  if (manager === "yarn" && args[0] && !args[0].startsWith("-") && !YARN_BUILT_INS.has(args[0])) {
    return { manager, script: args[0] };
  }

  return undefined;
}

async function readPackageScripts(cwd: string): Promise<Record<string, unknown> | undefined> {
  const packagePath = path.join(cwd, "package.json");
  if (!(await fs.pathExists(packagePath))) {
    return undefined;
  }

  const packageJson = await fs.readJson(packagePath) as { scripts?: unknown };
  return packageJson.scripts && typeof packageJson.scripts === "object"
    ? packageJson.scripts as Record<string, unknown>
    : {};
}

async function commandChecks(
  cwd: string,
  name: string,
  command: string,
  packageScripts: Record<string, unknown> | undefined
): Promise<DoctorCheck[]> {
  const executable = executableFromCommand(command);
  if (!executable) {
    return [check(name, "error", `Could not identify executable in "${command}".`, "Use a command beginning with an executable available on PATH.")];
  }

  const checks = await executableExists(cwd, executable)
    ? [check(name, "pass", `Executable "${executable}" is available.`)]
    : [check(name, "error", `Executable "${executable}" was not found or is not runnable.`, `Install ${executable} or update command "${command}".`)];
  const packageScript = packageScriptFromCommand(command);

  if (packageScript) {
    if (!packageScripts) {
      checks.push(check(
        `${name} script`,
        "error",
        `Cannot verify "${packageScript.script}" because package.json is missing.`,
        `Add package.json with scripts.${packageScript.script}, or update command "${command}".`
      ));
    } else if (!(packageScript.script in packageScripts)) {
      checks.push(check(
        `${name} script`,
        "error",
        `${packageScript.manager} script "${packageScript.script}" is missing from package.json.`,
        `Add "${packageScript.script}" to package.json scripts, or update command "${command}".`
      ));
    } else {
      checks.push(check(`${name} script`, "pass", `package.json script "${packageScript.script}" exists.`));
    }
  }

  return checks;
}

function buildReport(checks: DoctorCheck[]): DoctorReport {
  const errors = checks.filter((item) => item.level === "error").length;
  const warnings = checks.filter((item) => item.level === "warning").length;
  return {
    checks,
    passed: errors === 0,
    errors,
    warnings
  };
}

export async function diagnoseRepository(cwd: string, configPath = "ariadne.yml"): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let loadedConfig: Awaited<ReturnType<typeof loadConfig>>;

  try {
    loadedConfig = await loadConfig(cwd, configPath);
    checks.push(check("config", "pass", `Config parsed: ${path.relative(cwd, loadedConfig.path) || loadedConfig.path}`));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push(check("config", "error", message, `Fix ${configPath}, then run "ariadne doctor" again.`));
    return buildReport(checks);
  }

  try {
    const tasks = await loadTasks(cwd, loadedConfig.config.tasks.directory);
    checks.push(check("tasks", "pass", `Loaded ${tasks.length} valid task file${tasks.length === 1 ? "" : "s"} from ${loadedConfig.config.tasks.directory}.`));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push(check("tasks", "error", message, "Create or fix task YAML files before running Ariadne."));
  }

  let packageScripts: Record<string, unknown> | undefined;
  try {
    packageScripts = await readPackageScripts(cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push(check("package.json", "warning", `Could not parse package.json: ${message}`, "Fix package.json so verification scripts can be checked."));
  }

  checks.push(...await commandChecks(cwd, "agent", loadedConfig.config.agent.command, packageScripts));

  if (loadedConfig.config.verification.commands.length === 0) {
    checks.push(check(
      "verification",
      "warning",
      "No verification commands configured.",
      "Add verification.commands so Ariadne can validate agent work."
    ));
  } else {
    for (const [index, command] of loadedConfig.config.verification.commands.entries()) {
      checks.push(...await commandChecks(cwd, `verification ${index + 1}`, command, packageScripts));
    }
  }

  return buildReport(checks);
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = ["Ariadne doctor", ""];

  for (const item of report.checks) {
    lines.push(`${item.level.toUpperCase()} ${item.name}: ${item.message}`);
    if (item.suggestion) {
      lines.push(`  Suggestion: ${item.suggestion}`);
    }
  }

  const passed = report.checks.length - report.errors - report.warnings;
  const warningLabel = report.warnings === 1 ? "warning" : "warnings";
  const errorLabel = report.errors === 1 ? "error" : "errors";
  lines.push("", `Summary: ${passed} passed, ${report.warnings} ${warningLabel}, ${report.errors} ${errorLabel}`);
  return lines.join("\n");
}
