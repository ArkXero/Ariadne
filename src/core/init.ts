import os from "node:os";
import path from "node:path";
import { open, rm } from "node:fs/promises";
import fs from "fs-extra";
import { stringify } from "yaml";
import { atomicWriteFile } from "./atomic.js";
import { loadConfig } from "./config.js";
import { AriadneError } from "./errors.js";
import type { DetectedCommand, RepositoryDetection } from "./project-detector.js";
import type { IsolationStrategy, ProcessSpec } from "../types/index.js";

const CONFIG_PATH = "ariadne.yml";
const TASKS_DIRECTORY = ".ariadne/tasks";
const GITIGNORE_ENTRIES = ["/.ariadne/", "/ariadne.yml", "/ariadne.yml.backup-*"];
const RUNTIME_DIRECTORIES = ["runs", "batches", "worktrees", "promotions"];

export interface InitSettings {
  agent: ProcessSpec;
  selectedCommandIds: string[];
  sequentialTasks: boolean;
  isolation: IsolationStrategy;
  concurrency: number;
  retryAttempts: number;
  protectSensitiveFiles: boolean;
  maxChangedFiles?: number;
  maxDiffLines?: number;
  timeoutMinutes: number;
}

export type InitFileAction = "create" | "update" | "unchanged";

export interface InitProposedFile {
  path: string;
  action: InitFileAction;
  before?: string;
  after: string;
}

export interface InitProposal {
  replacement: boolean;
  settings: InitSettings;
  configContents: string;
  files: InitProposedFile[];
  taskIds: string[];
}

export interface InitResult {
  config: "created" | "replaced" | "skipped";
  task: "created" | "skipped";
  tasks: {
    created: string[];
    skipped: string[];
  };
  runsDirectory: "ready" | "untouched";
  batchesDirectory: "ready" | "untouched";
  worktreesDirectory: "ready" | "untouched";
  promotionsDirectory: "ready" | "untouched";
  gitignore: "created" | "updated" | "unchanged";
  backup?: string;
  configurationValidated: boolean;
}

function portableAgent(): ProcessSpec {
  return { kind: "exec", file: "node", args: ["-e", "process.stdin.pipe(process.stdout)"] };
}

export function defaultInitSettings(detection: RepositoryDetection, repositoryAware = true): InitSettings {
  const selectedCommandIds = repositoryAware && detection.validationCommand ? [detection.validationCommand.id] : [];
  const isolation: IsolationStrategy = "shared";
  return {
    agent: repositoryAware ? detection.agents[0]?.process ?? portableAgent() : portableAgent(),
    selectedCommandIds,
    sequentialTasks: false,
    isolation,
    concurrency: 1,
    retryAttempts: 1,
    protectSensitiveFiles: true,
    ...(detection.git.available ? { maxChangedFiles: 25, maxDiffLines: 1_500 } : {}),
    timeoutMinutes: 30
  };
}

function taskIdForCommand(command: DetectedCommand, used: Set<string>): string {
  const base = command.id
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 64) || "task";
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate.toLowerCase())) {
    const marker = `-${suffix++}`;
    candidate = `${base.slice(0, 64 - marker.length)}${marker}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function generatedConfig(settings: InitSettings, validationCommand?: DetectedCommand): string {
  const config = {
    version: 5,
    agent: {
      command: settings.agent,
      timeout_ms: settings.timeoutMinutes * 60_000,
      model_label: "local-agent"
    },
    tasks: { directory: TASKS_DIRECTORY },
    verification: {
      commands: validationCommand ? [validationCommand.process] : [],
      timeout_ms: settings.timeoutMinutes * 60_000
    },
    execution: {
      termination_grace_ms: 2_000,
      concurrency: settings.concurrency,
      failure_mode: "continue",
      isolation: settings.isolation,
      worktree: {
        retention: "on-failure",
        preparation: {
          commands: [],
          timeout_ms: 600_000
        }
      }
    },
    checks: {
      forbidden_files: settings.protectSensitiveFiles ? [".env", ".env.*", "**/*.pem", "**/*.key"] : [],
      ...(settings.maxChangedFiles === undefined ? {} : { max_changed_files: settings.maxChangedFiles }),
      ...(settings.maxDiffLines === undefined ? {} : { max_diff_lines: settings.maxDiffLines }),
      forbidden_commands: ["rm -rf"]
    }
  };
  return stringify(config, { indent: 2, lineWidth: 0 });
}

function generatedTask(command: DetectedCommand, id: string, dependsOn: string[], settings: InitSettings): string {
  const longRunning = command.script === "dev" || command.script.startsWith("dev:");
  const task = {
    id,
    name: `${command.script} reliability`,
    dependsOn,
    workspaceMode: "mutable",
    retry: {
      attempts: settings.retryAttempts,
      delayMs: settings.retryAttempts > 1 ? 1_000 : 0,
      backoff: "fixed"
    },
    metadata: {
      importedFrom: "package.json",
      command: command.display
    },
    ...(!longRunning ? { verify: [command.process] } : {}),
    prompt: longRunning
      ? `Inspect the ${command.display} development workflow and fix the smallest reproducible startup issue. Do not leave a development server running.`
      : `Run ${command.display}, diagnose any failures, and make the smallest safe changes needed for it to pass.`
  };
  return stringify(task, { indent: 2, lineWidth: 0 });
}

function exampleTask(settings: InitSettings): string {
  return stringify({
    id: "example",
    name: "Example reliability task",
    dependsOn: [],
    workspaceMode: "mutable",
    retry: { attempts: settings.retryAttempts, delayMs: settings.retryAttempts > 1 ? 1_000 : 0, backoff: "fixed" },
    metadata: {},
    prompt: "Inspect this repository and make the smallest safe change that improves the project.\nDo not edit forbidden files. Run the configured verification command before finishing."
  }, { indent: 2, lineWidth: 0 });
}

async function proposedGitignore(cwd: string): Promise<InitProposedFile> {
  const filePath = path.join(cwd, ".gitignore");
  const exists = await fs.pathExists(filePath);
  const before = exists ? await fs.readFile(filePath, "utf8") : "";
  const lines = new Set(before.split(/\r?\n/).map((line) => line.trim()));
  const missing = GITIGNORE_ENTRIES.filter((entry) => !lines.has(entry));
  if (missing.length === 0) return { path: ".gitignore", action: "unchanged", before, after: before };
  const separator = before.length === 0 ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  return {
    path: ".gitignore",
    action: exists ? "update" : "create",
    ...(exists ? { before } : {}),
    after: `${before}${separator}${["# Ariadne", ...missing, ""].join("\n")}`
  };
}

export async function buildInitProposal(cwd: string, detection: RepositoryDetection, settings: InitSettings): Promise<InitProposal> {
  for (const relative of [CONFIG_PATH, ".gitignore", ".ariadne", TASKS_DIRECTORY]) {
    const candidate = path.join(cwd, relative);
    const candidateStat = await fs.lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (candidateStat?.isSymbolicLink()) {
      throw new AriadneError({
        category: "configuration",
        code: "INIT_SYMLINK_UNSUPPORTED",
        stage: "loading",
        source: candidate,
        message: `Initialization will not read from or write through the ${relative} symlink.`,
        correction: "Replace the symlink with a project-local file or directory, then run ariadne init again."
      });
    }
  }
  const configPath = path.join(cwd, CONFIG_PATH);
  const configExists = await fs.pathExists(configPath);
  const beforeConfig = configExists ? await fs.readFile(configPath, "utf8") : undefined;
  const selected = settings.selectedCommandIds
    .map((id) => detection.commands.find((command) => command.id === id))
    .filter((command): command is DetectedCommand => Boolean(command));
  const validationCommand = detection.validationCommand;
  const configContents = generatedConfig(settings, validationCommand);
  const files: InitProposedFile[] = [{
    path: CONFIG_PATH,
    action: configExists ? "update" : "create",
    ...(beforeConfig === undefined ? {} : { before: beforeConfig }),
    after: configContents
  }];
  const used = new Set<string>();
  const taskIds: string[] = [];
  if (selected.length === 0) {
    taskIds.push("example");
    const taskPath = `${TASKS_DIRECTORY}/example.yml`;
    const absolute = path.join(cwd, taskPath);
    const exists = await fs.pathExists(absolute);
    const before = exists ? await fs.readFile(absolute, "utf8") : undefined;
    files.push({ path: taskPath, action: exists ? "unchanged" : "create", ...(before === undefined ? {} : { before }), after: before ?? exampleTask(settings) });
  } else {
    for (const [index, command] of selected.entries()) {
      const id = taskIdForCommand(command, used);
      taskIds.push(id);
      const taskPath = `${TASKS_DIRECTORY}/${id}.yml`;
      const absolute = path.join(cwd, taskPath);
      const exists = await fs.pathExists(absolute);
      const before = exists ? await fs.readFile(absolute, "utf8") : undefined;
      const dependsOn = settings.sequentialTasks && index > 0 ? [taskIds[index - 1]] : [];
      files.push({ path: taskPath, action: exists ? "unchanged" : "create", ...(before === undefined ? {} : { before }), after: before ?? generatedTask(command, id, dependsOn, settings) });
    }
  }
  files.push(await proposedGitignore(cwd));
  return { replacement: configExists, settings, configContents, files, taskIds };
}

export async function validateInitProposal(proposal: InitProposal): Promise<void> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "ariadne-init-validate-"));
  try {
    await fs.writeFile(path.join(temporary, CONFIG_PATH), proposal.configContents, { mode: 0o600 });
    await loadConfig(temporary);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function reserveBackupPath(cwd: string, contents: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  for (let suffix = 0; ; suffix += 1) {
    const relative = `ariadne.yml.backup-${stamp}${suffix === 0 ? "" : `-${suffix}`}`;
    const absolute = path.join(cwd, relative);
    try {
      const handle = await open(absolute, "wx", 0o600);
      try {
        await handle.writeFile(contents);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return relative;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

async function assertProposalFileState(cwd: string, file: InitProposedFile): Promise<void> {
  const absolute = path.join(cwd, file.path);
  const state = await fs.lstat(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const changed = file.action === "create"
    ? state !== undefined
    : state === undefined || state.isSymbolicLink() || await fs.readFile(absolute, "utf8") !== file.before;
  if (changed) {
    throw new AriadneError({
      category: "configuration",
      code: "INIT_FILE_CHANGED",
      stage: "persisting",
      source: absolute,
      message: `${file.path} changed after the proposal was reviewed.`,
      correction: "Nothing was overwritten. Review the latest file contents and run ariadne init again."
    });
  }
}

export async function applyInitProposal(cwd: string, proposal: InitProposal): Promise<InitResult> {
  await validateInitProposal(proposal);
  const writableFiles = proposal.files.filter((file) => file.action !== "unchanged");
  const originals = new Map<string, string | undefined>();
  const originalModes = new Map<string, number>();
  const written: string[] = [];
  let backup: string | undefined;
  for (const file of writableFiles) await assertProposalFileState(cwd, file);
  for (const file of writableFiles) {
    originals.set(file.path, file.before);
    if (file.before !== undefined) originalModes.set(file.path, (await fs.stat(path.join(cwd, file.path))).mode & 0o777);
  }
  if (proposal.replacement) {
    const original = proposal.files.find((file) => file.path === CONFIG_PATH)?.before;
    if (original === undefined) throw new AriadneError({ category: "configuration", code: "INIT_REPLACEMENT_SOURCE_MISSING", stage: "persisting", message: "The existing configuration disappeared before replacement.", correction: "Run ariadne init again and review the new proposal." });
    backup = await reserveBackupPath(cwd, original);
  }
  try {
    for (const directory of [TASKS_DIRECTORY, ...RUNTIME_DIRECTORIES.map((name) => `.ariadne/${name}`)]) {
      await fs.ensureDir(path.join(cwd, directory));
    }
    for (const file of writableFiles) {
      const absolute = path.join(cwd, file.path);
      await assertProposalFileState(cwd, file);
      written.push(file.path);
      await atomicWriteFile(absolute, file.after);
      const originalMode = originalModes.get(file.path);
      if (originalMode !== undefined) await fs.chmod(absolute, originalMode);
    }
  } catch (error) {
    for (const filePath of written.reverse()) {
      const absolute = path.join(cwd, filePath);
      const original = originals.get(filePath);
      if (original === undefined) await rm(absolute, { force: true });
      else {
        await atomicWriteFile(absolute, original);
        const originalMode = originalModes.get(filePath);
        if (originalMode !== undefined) await fs.chmod(absolute, originalMode);
      }
    }
    throw error;
  }
  const created = proposal.files.filter((file) => file.path.startsWith(`${TASKS_DIRECTORY}/`) && file.action === "create").map((file) => file.path);
  const skipped = proposal.files.filter((file) => file.path.startsWith(`${TASKS_DIRECTORY}/`) && file.action === "unchanged").map((file) => file.path);
  const gitignore = proposal.files.find((file) => file.path === ".gitignore")?.action ?? "unchanged";
  return {
    config: proposal.replacement ? "replaced" : "created",
    task: created.length > 0 ? "created" : "skipped",
    tasks: { created, skipped },
    runsDirectory: "ready",
    batchesDirectory: "ready",
    worktreesDirectory: "ready",
    promotionsDirectory: "ready",
    gitignore: gitignore === "create" ? "created" : gitignore === "update" ? "updated" : "unchanged",
    ...(backup ? { backup } : {}),
    configurationValidated: true
  };
}

export async function initCommand(cwd: string): Promise<InitResult> {
  const { detectRepository } = await import("./project-detector.js");
  const detection = await detectRepository(cwd);
  if (await fs.pathExists(path.join(cwd, CONFIG_PATH))) {
    const taskPath = path.join(cwd, TASKS_DIRECTORY, "example.yml");
    const directoryState = async (name: string): Promise<"ready" | "untouched"> => await fs.pathExists(path.join(cwd, ".ariadne", name)) ? "ready" : "untouched";
    return {
      config: "skipped",
      task: await fs.pathExists(taskPath) ? "skipped" : "skipped",
      tasks: { created: [], skipped: await fs.pathExists(taskPath) ? [`${TASKS_DIRECTORY}/example.yml`] : [] },
      runsDirectory: await directoryState("runs"),
      batchesDirectory: await directoryState("batches"),
      worktreesDirectory: await directoryState("worktrees"),
      promotionsDirectory: await directoryState("promotions"),
      gitignore: "unchanged",
      configurationValidated: false
    };
  }
  const portableDetection: RepositoryDetection = {
    projectType: detection.projectType,
    ...(detection.packageManager ? { packageManager: detection.packageManager } : {}),
    commands: [],
    agents: detection.agents,
    git: detection.git,
    warnings: detection.warnings
  };
  return applyInitProposal(cwd, await buildInitProposal(cwd, portableDetection, defaultInitSettings(portableDetection, false)));
}

function diffLines(before: string, after: string): string[] {
  const left = before.split("\n");
  const right = after.split("\n");
  const table = Array.from({ length: left.length + 1 }, () => Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  }
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      lines.push(` ${left[i]}`);
      i += 1;
      j += 1;
    } else if (j < right.length && (i === left.length || table[i][j + 1] >= table[i + 1][j])) {
      lines.push(`+${right[j++]}`);
    } else {
      lines.push(`-${left[i++]}`);
    }
  }
  return lines;
}

export function formatProposalDiff(proposal: InitProposal): string {
  const sections: string[] = [];
  for (const file of proposal.files.filter((item) => item.action !== "unchanged")) {
    sections.push(`--- ${file.before === undefined ? "/dev/null" : `a/${file.path}`}`, `+++ b/${file.path}`, "@@");
    sections.push(...diffLines(file.before ?? "", file.after));
  }
  return sections.join("\n");
}

export function formatProposalFiles(proposal: InitProposal): string {
  const created = proposal.files.filter((file) => file.action === "create").map((file) => file.path);
  const updated = proposal.files.filter((file) => file.action === "update").map((file) => file.path);
  const lines: string[] = [];
  if (created.length > 0) lines.push("Files to create:", ...created.map((file) => `  ${file}`));
  if (updated.length > 0) lines.push(...(lines.length > 0 ? [""] : []), "Files to update:", ...updated.map((file) => `  ${file}`));
  if (proposal.replacement) lines.push(...(lines.length > 0 ? [""] : []), "Backup to create:", "  ariadne.yml.backup-<timestamp>");
  return lines.join("\n");
}

export function formatInitResult(result: InitResult): string {
  const taskLines = [...result.tasks.created.map((file) => `${file} created`), ...result.tasks.skipped.map((file) => `${file} skipped`)];
  return [
    `ariadne.yml ${result.config}`,
    ...taskLines,
    `.ariadne/runs ${result.runsDirectory}`,
    `.ariadne/batches ${result.batchesDirectory}`,
    `.ariadne/worktrees ${result.worktreesDirectory}`,
    `.ariadne/promotions ${result.promotionsDirectory}`,
    `.gitignore ${result.gitignore}`,
    ...(result.backup ? [`backup ${result.backup}`] : [])
  ].join("\n");
}
