import path from "node:path";
import { constants } from "node:fs";
import fs from "fs-extra";
import { actualCommand } from "./command-utils.js";
import { renderProcessSpec, loadConfig } from "./config.js";
import { formatAriadneError, AriadneError } from "./errors.js";
import { captureRepositorySnapshot } from "./git.js";
import { listWorkspaces } from "./workspace-manager.js";
import { loadPromotions } from "./promotion.js";
import { loadTasks } from "./task-loader.js";
import { WorkflowGraph } from "./workflow-graph.js";
import type { AriadneTask, ProcessSpec } from "../types/index.js";

export type DoctorCheckStatus = "pass" | "warning" | "fail";

export interface DoctorCheck {
  id: string;
  status: DoctorCheckStatus;
  message: string;
  remediation?: string;
  resolvedPath?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  passed: boolean;
  errors: number;
  warnings: number;
}

function check(id: string, status: DoctorCheckStatus, message: string, remediation?: string, resolvedPath?: string): DoctorCheck {
  return { id, status, message, ...(remediation ? { remediation } : {}), ...(resolvedPath ? { resolvedPath } : {}) };
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

async function commandCheck(cwd: string, id: string, spec: ProcessSpec): Promise<DoctorCheck> {
  const executable = actualCommand(spec).file;
  const display = renderProcessSpec(spec);
  return await executableExists(cwd, executable)
    ? check(id, "pass", `Executable "${executable}" is available for ${display}.`)
    : check(id, "fail", `Executable "${executable}" was not found or is not runnable.`, `Install ${executable} or update the process spec.`);
}

function packageScriptReference(spec: ProcessSpec): { manager: string; script: string } | undefined {
  let tokens: string[];
  if (spec.kind === "exec") {
    tokens = [path.basename(spec.file).replace(/\.(?:cmd|exe)$/i, ""), ...spec.args];
  } else {
    const match = spec.command.trim().match(/^(?:env\s+\S+\s+)*(pnpm|npm|yarn|bun)\s+(.+)$/);
    if (!match) return undefined;
    tokens = [match[1], ...match[2].trim().split(/\s+/)];
  }
  const manager = tokens[0].toLowerCase();
  if (!["pnpm", "npm", "yarn", "bun"].includes(manager)) return undefined;
  const args = tokens.slice(1).filter((value) => !value.startsWith("--"));
  const candidate = args[0] === "run" ? args[1] : args[0];
  const builtins = new Set(["add", "audit", "ci", "config", "dlx", "exec", "install", "link", "pack", "publish", "remove", "uninstall", "version"]);
  if (!candidate || builtins.has(candidate)) return undefined;
  return { manager, script: candidate };
}

async function scriptCheck(cwd: string, id: string, spec: ProcessSpec): Promise<DoctorCheck | undefined> {
  const reference = packageScriptReference(spec);
  if (!reference) return undefined;
  const packagePath = path.join(cwd, "package.json");
  if (!(await fs.pathExists(packagePath))) {
    return check(id, "fail", `${reference.manager} script "${reference.script}" requires package.json.`, "Create package.json or update the command.", packagePath);
  }
  try {
    const manifest = await fs.readJson(packagePath) as { scripts?: Record<string, unknown> };
    return typeof manifest.scripts?.[reference.script] === "string"
      ? check(id, "pass", `Package script "${reference.script}" is defined.`, undefined, packagePath)
      : check(id, "fail", `Package script "${reference.script}" is not defined.`, `Add scripts.${reference.script} or update the command.`, packagePath);
  } catch (error) {
    return check(id, "fail", `Could not read package.json: ${error instanceof Error ? error.message : String(error)}`, "Fix package.json syntax.", packagePath);
  }
}

function buildReport(checks: DoctorCheck[]): DoctorReport {
  const errors = checks.filter((item) => item.status === "fail").length;
  const warnings = checks.filter((item) => item.status === "warning").length;
  return { checks, passed: errors === 0, errors, warnings };
}

async function nearestExistingAncestor(candidate: string): Promise<string> {
  let current = candidate;
  while (!(await fs.pathExists(current))) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

export async function diagnoseRepository(cwd: string, configPath = "ariadne.yml", verbose = false): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  checks.push(
    Number(process.versions.node.split(".")[0]) >= 20
      ? check("runtime.node", "pass", `Node ${process.version} satisfies the >=20 requirement.`)
      : check("runtime.node", "fail", `Node ${process.version} is unsupported.`, "Install Node.js 20 or newer.")
  );

  let loaded: Awaited<ReturnType<typeof loadConfig>>;
  try {
    loaded = await loadConfig(cwd, configPath);
    checks.push(check("config.load", "pass", `Configuration version ${loaded.config.sourceVersion} loaded and normalized to v${loaded.config.version}.`, undefined, loaded.path));
    for (const warning of loaded.warnings) checks.push(check("config.compatibility", "warning", warning, `Migrate the configuration to version ${loaded.config.version}.`));
  } catch (error) {
    const message = error instanceof AriadneError ? formatAriadneError(error, verbose) : error instanceof Error ? verbose && error.stack ? error.stack : error.message : String(error);
    checks.push(check("config.load", "fail", message, "Fix the configuration and run doctor again."));
    return buildReport(checks);
  }

  let tasks: AriadneTask[] = [];
  try {
    tasks = await loadTasks(loaded.projectRoot, loaded.config.tasks.directory, loaded.config.sourceVersion);
    new WorkflowGraph(tasks);
    checks.push(check("tasks.load", "pass", `Loaded ${tasks.length} unique valid task${tasks.length === 1 ? "" : "s"}.`, undefined, path.resolve(loaded.projectRoot, loaded.config.tasks.directory)));
    checks.push(check("tasks.duplicates", "pass", "Task IDs are unique when compared case-insensitively."));
    checks.push(check("workflow.graph", "pass", "Task dependency graph is valid and acyclic."));
  } catch (error) {
    checks.push(check(error instanceof AriadneError && error.code === "TASK_ID_DUPLICATE" ? "tasks.duplicates" : "tasks.load", "fail", error instanceof Error ? error.message : String(error), "Create or fix task YAML files."));
  }

  checks.push(await commandCheck(loaded.projectRoot, "agent.executable", loaded.config.agent.command));
  const agentScript = await scriptCheck(loaded.projectRoot, "agent.script", loaded.config.agent.command);
  if (agentScript) checks.push(agentScript);
  for (const [index, command] of loaded.config.verification.commands.entries()) {
    checks.push(await commandCheck(loaded.projectRoot, `verification.${index + 1}.executable`, command));
    const verificationScript = await scriptCheck(loaded.projectRoot, `verification.${index + 1}.script`, command);
    if (verificationScript) checks.push(verificationScript);
  }
  for (const task of tasks) {
    for (const [index, command] of (task.verify ?? []).entries()) {
      checks.push(await commandCheck(loaded.projectRoot, `task.${task.id}.verification.${index + 1}.executable`, command));
      const script = await scriptCheck(loaded.projectRoot, `task.${task.id}.verification.${index + 1}.script`, command);
      if (script) checks.push(script);
    }
  }
  for (const [index, command] of loaded.config.execution.worktree.preparation.commands.entries()) {
    checks.push(await commandCheck(loaded.projectRoot, `worktree.preparation.${index + 1}.executable`, command));
    const script = await scriptCheck(loaded.projectRoot, `worktree.preparation.${index + 1}.script`, command);
    if (script) checks.push(script);
  }
  if (loaded.config.verification.commands.length === 0) {
    checks.push(check("verification.configured", "warning", "No verification commands configured.", "Add at least one deterministic verification command."));
  }

  const repository = await captureRepositorySnapshot(loaded.projectRoot);
  const requiresGit = loaded.config.checks.max_changed_files !== undefined || loaded.config.checks.max_diff_lines !== undefined;
  checks.push(repository.available
    ? check("repository.git", "pass", `Git repository is available${repository.branch ? ` on branch ${repository.branch}` : " in detached state"}.`)
    : check("repository.git", requiresGit ? "fail" : "warning", repository.unavailableReason ?? "Git state is unavailable.", requiresGit ? "Initialize Git or remove Git-dependent limits." : "Initialize Git for changed-file and diff attribution."));
  checks.push(!repository.available
    ? check("worktree.capability", loaded.config.execution.isolation === "worktree" ? "fail" : "warning", "Git worktree capability is unavailable outside a Git repository.", "Use shared isolation or initialize Git with a committed HEAD.")
    : !repository.head
      ? check("worktree.capability", loaded.config.execution.isolation === "worktree" ? "fail" : "warning", "Git repository has no committed HEAD for detached worktree creation.", "Create an initial commit before using worktree isolation.")
      : check("worktree.capability", "pass", `Git worktree isolation can use committed source ${repository.head.slice(0, 12)}.`));
  checks.push(repository.dirty
    ? check("worktree.source-clean", "warning", "The primary checkout is dirty; isolated runs reject it unless --allow-dirty-base is explicit.", "Commit or clean the checkout. Acknowledged dirt is excluded from isolated worktrees.")
    : check("worktree.source-clean", "pass", "Primary checkout is clean for worktree isolation."));

  const runsDirectory = path.join(loaded.projectRoot, ".ariadne", "runs");
  const writableTarget = await nearestExistingAncestor(runsDirectory);
  const writable = await fs.access(writableTarget, constants.W_OK).then(() => true, () => false);
  checks.push(writable
    ? check("runs.writable", "pass", "Run storage can be created from a writable existing ancestor.", undefined, runsDirectory)
    : check("runs.writable", "fail", `Run storage cannot be created because ${writableTarget} is not writable.`, "Fix directory ownership or permissions.", runsDirectory));

  const batchesDirectory = path.join(loaded.projectRoot, ".ariadne", "batches");
  const batchesTarget = await nearestExistingAncestor(batchesDirectory);
  const batchesWritable = await fs.access(batchesTarget, constants.W_OK).then(() => true, () => false);
  checks.push(batchesWritable
    ? check("batches.writable", "pass", "Batch storage can be created from a writable existing ancestor.", undefined, batchesDirectory)
    : check("batches.writable", "fail", `Batch storage cannot be created because ${batchesTarget} is not writable.`, "Fix directory ownership or permissions.", batchesDirectory));
  const worktreesDirectory = path.join(loaded.projectRoot, ".ariadne", "worktrees");
  const worktreesTarget = await nearestExistingAncestor(worktreesDirectory);
  const worktreesWritable = await fs.access(worktreesTarget, constants.W_OK).then(() => true, () => false);
  checks.push(worktreesWritable
    ? check("worktrees.writable", "pass", "Managed worktree metadata can be created from a writable existing ancestor.", undefined, worktreesDirectory)
    : check("worktrees.writable", "fail", `Managed worktree storage cannot be created because ${worktreesTarget} is not writable.`, "Fix directory ownership or permissions.", worktreesDirectory));
  const workspaces = await listWorkspaces(loaded.projectRoot);
  const stale = workspaces.filter((item) => item.warning || item.record && ["creating", "preparing", "running", "capturing", "removing", "stale", "failed"].includes(item.record.state));
  checks.push(stale.length > 0
    ? check("worktrees.stale", "warning", `${stale.length} managed workspace record(s) are corrupt, uncertain, stale, or failed.`, "Inspect ariadne worktree list, then use ariadne worktree clean --dry-run.")
    : check("worktrees.stale", "pass", "No stale or corrupt managed workspace records were found."));
  const promotions = await loadPromotions(loaded.projectRoot);
  const incompletePromotions = promotions.filter((item) => item.warning || item.record && ["validating", "preflighting", "applying"].includes(item.record.status));
  checks.push(incompletePromotions.length > 0
    ? check("promotion.incomplete", "warning", `${incompletePromotions.length} promotion record(s) are corrupt or incomplete.`, "Inspect promotion metadata before applying another result; Ariadne will not assume ownership of unrelated Git state.")
    : check("promotion.incomplete", "pass", "No incomplete promotion records were found."));
  checks.push(loaded.config.execution.concurrency > 1 && loaded.config.execution.isolation === "shared" && !tasks.some((task) => task.workspaceMode === "read-only")
    ? check("workflow.concurrency", "warning", `Concurrency is ${loaded.config.execution.concurrency}, but every shared-mode task is mutable; execution will remain serial.`, "Declare only genuinely non-mutating tasks workspaceMode: read-only, or select worktree isolation for mutable overlap.")
    : check("workflow.concurrency", "pass", `Workflow concurrency ${loaded.config.execution.concurrency} has a coherent task safety configuration.`));

  return buildReport(checks);
}

export function formatDoctorReport(report: DoctorReport): string {
  const labels: Record<DoctorCheckStatus, string> = { pass: "PASS", warning: "WARN", fail: "FAIL" };
  const lines = ["Ariadne doctor", ""];
  for (const item of report.checks) {
    lines.push(`${labels[item.status]} ${item.id}: ${item.message}`);
    if (item.resolvedPath) lines.push(`  Path: ${item.resolvedPath}`);
    if (item.remediation) lines.push(`  Remediation: ${item.remediation}`);
  }
  lines.push("", `Summary: ${report.checks.length - report.errors - report.warnings} passed, ${report.warnings} warnings, ${report.errors} failures`);
  return lines.join("\n");
}
