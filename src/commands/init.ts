import path from "node:path";
import fs from "fs-extra";
import { diagnoseRepository, formatDoctorReport, type DoctorReport } from "../core/doctor.js";
import {
  applyInitProposal,
  buildInitProposal,
  defaultInitSettings,
  formatProposalDiff,
  formatProposalFiles,
  initCommand,
  validateInitProposal,
  type InitProposal,
  type InitResult,
  type InitSettings
} from "../core/init.js";
import { detectRepository, type RepositoryDetection } from "../core/project-detector.js";
import { withAriadneTerminalTheme } from "../theme.js";
import type { ProcessSpec } from "../types/index.js";

export { formatInitResult, initCommand } from "../core/init.js";

type SelectValue = string | number | boolean;

export interface InitPrompt {
  intro(message: string): void;
  outro(message: string): void;
  cancel(message: string): void;
  note(message: string, title?: string): void;
  info(message: string): void;
  success(message: string): void;
  warning(message: string): void;
  start(message: string): void;
  stop(message: string, success?: boolean): void;
  select<T extends SelectValue>(options: { message: string; choices: Array<{ value: T; label: string; hint?: string }>; initialValue?: T }): Promise<T>;
  multiselect<T extends SelectValue>(options: { message: string; choices: Array<{ value: T; label: string; hint?: string }>; initialValues?: T[]; required?: boolean }): Promise<T[]>;
  confirm(options: { message: string; initialValue?: boolean }): Promise<boolean>;
  text(options: { message: string; initialValue?: string; placeholder?: string; validate?: (value: string) => string | undefined }): Promise<string>;
}

export interface InitOnboardingOptions {
  interactive: boolean;
  repositoryAware: boolean;
  custom?: boolean;
  json?: boolean;
  quiet?: boolean;
  color?: boolean;
}

export type InitOnboardingOutcome =
  | { kind: "created"; result: InitResult; doctor: DoctorReport; taskIds: string[] }
  | { kind: "validated"; doctor: DoctorReport }
  | { kind: "skipped"; result: InitResult };

export function initOutcomeJson(outcome: InitOnboardingOutcome): Record<string, unknown> {
  if (outcome.kind === "skipped") return outcome;
  const doctor = { passed: outcome.doctor.passed, errors: outcome.doctor.errors, warnings: outcome.doctor.warnings };
  return outcome.kind === "validated"
    ? { kind: outcome.kind, doctor }
    : { kind: outcome.kind, result: outcome.result, doctor, taskIds: outcome.taskIds };
}

class InitCancelled extends Error {}

function integerValidation(minimum: number, maximum: number, allowNone = false): (value: string) => string | undefined {
  return (value) => {
    if (allowNone && value.trim().toLowerCase() === "none") return undefined;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? undefined : `Enter an integer from ${minimum} through ${maximum}${allowNone ? ", or none" : ""}.`;
  };
}

function parseInteger(value: string, allowNone = false): number | undefined {
  if (allowNone && value.trim().toLowerCase() === "none") return undefined;
  return Number(value);
}

function parseArguments(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) throw new Error("Arguments must be a JSON array of strings.");
    return parsed;
  }
  const matches = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return matches.map((token) => token.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_match, double: string | undefined, single: string | undefined) => double ?? single ?? token));
}

async function chooseAgent(ui: InitPrompt, detection: RepositoryDetection, current: ProcessSpec): Promise<ProcessSpec> {
  const detected = new Set(detection.agents.map((agent) => agent.id));
  const currentChoice = current.kind === "exec" && current.file === "codex" ? "codex" : current.kind === "exec" && current.file === "claude" ? "claude" : "custom";
  const choice = await ui.select({
    message: "Agent",
    choices: [
      { value: "codex", label: "Codex", hint: detected.has("codex") ? "detected" : "executable not detected" },
      { value: "claude", label: "Claude Code", hint: detected.has("claude") ? "detected" : "executable not detected" },
      { value: "custom", label: "Custom executable" }
    ],
    initialValue: currentChoice
  });
  if (choice === "codex") return { kind: "exec", file: "codex", args: ["exec", "--sandbox", "workspace-write", "-"] };
  if (choice === "claude") return { kind: "exec", file: "claude", args: ["-p"] };
  const executable = await ui.text({
    message: "Executable",
    initialValue: current.kind === "exec" ? current.file : "",
    placeholder: "my-agent",
    validate: (value) => value.trim() ? undefined : "Enter an executable name or path."
  });
  const argumentsText = await ui.text({
    message: "Arguments (space-separated or JSON array)",
    initialValue: current.kind === "exec" ? current.args.join(" ") : "",
    placeholder: "--non-interactive",
    validate: (value) => {
      try {
        parseArguments(value);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }
  });
  return { kind: "exec", file: executable.trim(), args: parseArguments(argumentsText) };
}

async function collectCustomSettings(ui: InitPrompt, detection: RepositoryDetection, previous?: InitSettings): Promise<InitSettings> {
  const defaults = previous ?? defaultInitSettings(detection);
  ui.note("1. Agent\n2. Tasks\n3. Workflow dependencies\n4. Task workspace\n5. Concurrency\n6. Retries\n7. File protections\n8. Change limits\n9. Timeout\n10. Review configuration", "Custom setup");
  const agent = await chooseAgent(ui, detection, defaults.agent);
  let selectedCommandIds: string[] = [];
  if (detection.commands.length > 0) {
    const initialValues = previous?.selectedCommandIds ?? detection.commands
      .filter((command) => ["check", "test", "build"].includes(command.script))
      .map((command) => command.id);
    selectedCommandIds = await ui.multiselect({
      message: "Import detected project commands as tasks? (Space to toggle, Enter to confirm)",
      choices: detection.commands.map((command) => ({
        value: command.id,
        label: `${command.script}  ${command.display}`,
        ...(command.script === "dev" || command.script.startsWith("dev:") ? { hint: "long-running; usually leave unchecked" } : {})
      })),
      initialValues: initialValues.length > 0 ? initialValues : defaults.selectedCommandIds,
      required: false
    });
  } else {
    ui.info("No package scripts were detected; Ariadne will create an example task.");
  }
  const dependencyMode = selectedCommandIds.length > 1
    ? await ui.select({
        message: "Workflow dependencies",
        choices: [
          { value: "independent", label: "Independent tasks", hint: "recommended when commands can run separately" },
          { value: "sequential", label: "Sequential in listed order", hint: "each task depends on the previous task" }
        ],
        initialValue: defaults.sequentialTasks ? "sequential" : "independent"
      })
    : "independent";
  const isolation = await ui.select({
    message: "Where should tasks run?",
    choices: [
      { value: "worktree", label: "Separate Git worktrees", hint: detection.git.worktreeIsolation ? "each task uses a separate project folder" : "unavailable until this Git repository has a commit" },
      { value: "shared", label: "This project folder", hint: "tasks that edit files run one at a time" }
    ],
    initialValue: previous ? defaults.isolation : detection.git.worktreeIsolation ? "worktree" : "shared"
  });
  const initialConcurrency = previous ? defaults.concurrency : isolation === "worktree" ? Math.min(2, Math.max(selectedCommandIds.length, 1)) : 1;
  const concurrency = parseInteger(await ui.text({
    message: "Maximum parallel tasks",
    initialValue: String(isolation === "shared" ? 1 : initialConcurrency),
    validate: integerValidation(1, 32)
  })) ?? 1;
  const retryAttempts = parseInteger(await ui.text({
    message: "Maximum attempts per task (1 means no retries)",
    initialValue: String(defaults.retryAttempts),
    validate: integerValidation(1, 10)
  })) ?? 1;
  const protectSensitiveFiles = await ui.confirm({ message: "Protect common sensitive files?", initialValue: defaults.protectSensitiveFiles });
  const maxChangedFiles = parseInteger(await ui.text({
    message: "Maximum changed files per task",
    initialValue: defaults.maxChangedFiles === undefined ? "none" : String(defaults.maxChangedFiles),
    validate: integerValidation(0, 100_000, true)
  }), true);
  const maxDiffLines = parseInteger(await ui.text({
    message: "Maximum diff lines per task",
    initialValue: defaults.maxDiffLines === undefined ? "none" : String(defaults.maxDiffLines),
    validate: integerValidation(0, 10_000_000, true)
  }), true);
  const timeoutMinutes = parseInteger(await ui.text({
    message: "Agent and verification timeout (minutes)",
    initialValue: String(defaults.timeoutMinutes),
    validate: integerValidation(1, 1_440)
  })) ?? 30;
  return {
    agent,
    selectedCommandIds,
    sequentialTasks: dependencyMode === "sequential",
    isolation,
    concurrency: isolation === "shared" ? 1 : concurrency,
    retryAttempts,
    protectSensitiveFiles,
    ...(maxChangedFiles === undefined ? {} : { maxChangedFiles }),
    ...(maxDiffLines === undefined ? {} : { maxDiffLines }),
    timeoutMinutes
  };
}

function showDetection(ui: InitPrompt, detection: RepositoryDetection): void {
  ui.success(`Detected ${detection.projectType}`);
  if (detection.packageManager) ui.success(`Detected ${detection.packageManager}`);
  if (detection.validationCommand) ui.success(`Detected validation command: ${detection.validationCommand.display}`);
  for (const agent of detection.agents) ui.success(`Detected ${agent.label} executable`);
  if (detection.agents.length === 0) ui.warning("No Codex or Claude Code executable detected; using a portable placeholder agent.");
  if (detection.git.worktreeIsolation) ui.success("Git worktree isolation available");
  else ui.warning("Git worktree isolation unavailable; defaulting to the shared working tree.");
  for (const warning of detection.warnings) ui.warning(warning);
}

async function reviewCustomProposal(ui: InitPrompt, proposal: InitProposal): Promise<"create" | "back"> {
  for (;;) {
    const choice = await ui.select({
      message: "Review generated configuration",
      choices: [
        { value: "yaml", label: "View YAML" },
        { value: "changes", label: "View file changes" },
        { value: "create", label: proposal.replacement ? "Replace configuration" : "Create configuration" },
        { value: "back", label: "Go back" },
        { value: "cancel", label: "Cancel" }
      ],
      initialValue: "create"
    });
    if (choice === "yaml") ui.note(proposal.configContents.trimEnd(), "ariadne.yml");
    else if (choice === "changes") ui.note(formatProposalDiff(proposal), "Proposed file changes");
    else if (choice === "back") return "back";
    else if (choice === "cancel") throw new InitCancelled();
    else return "create";
  }
}

async function buildReviewedCustomProposal(ui: InitPrompt, cwd: string, detection: RepositoryDetection): Promise<InitProposal> {
  let previous: InitSettings | undefined;
  for (;;) {
    previous = await collectCustomSettings(ui, detection, previous);
    const proposal = await buildInitProposal(cwd, detection, previous);
    if (proposal.replacement) ui.note(formatProposalDiff(proposal), "Required replacement diff");
    if (await reviewCustomProposal(ui, proposal) === "create") return proposal;
  }
}

async function validateExisting(ui: InitPrompt, cwd: string): Promise<InitOnboardingOutcome> {
  ui.start("Validating existing configuration...");
  const doctor = await diagnoseRepository(cwd);
  ui.stop(doctor.passed ? "Existing configuration validated" : "Existing configuration has errors", doctor.passed);
  ui.note(formatDoctorReport(doctor), "Validation result");
  return { kind: "validated", doctor };
}

async function writeProposal(ui: InitPrompt, cwd: string, proposal: InitProposal): Promise<InitOnboardingOutcome> {
  ui.start("Validating proposed configuration...");
  await validateInitProposal(proposal);
  ui.stop("Proposed configuration validated");
  ui.start(proposal.replacement ? "Backing up and replacing configuration..." : "Creating configuration...");
  const result = await applyInitProposal(cwd, proposal);
  ui.stop(proposal.replacement ? "Configuration safely replaced" : "Configuration created");
  ui.success(`${result.config === "replaced" ? "Replaced" : "Created"} ariadne.yml`);
  for (const file of result.tasks.created) ui.success(`Created ${file}`);
  if (result.gitignore === "updated") ui.success("Updated .gitignore");
  else if (result.gitignore === "created") ui.success("Created .gitignore");
  if (result.backup) ui.success(`Created backup ${result.backup}`);
  const doctor = await diagnoseRepository(cwd);
  if (doctor.passed) ui.success("Ariadne Doctor passed");
  else {
    ui.warning(`Ariadne Doctor found ${doctor.errors} error${doctor.errors === 1 ? "" : "s"}`);
    ui.note(formatDoctorReport(doctor), "Doctor result");
  }
  const firstTask = proposal.taskIds[0];
  ui.outro(["Next:", "  ariadne plan --all", `  ariadne run ${firstTask ?? "--all"}`].join("\n"));
  return { kind: "created", result, doctor, taskIds: proposal.taskIds };
}

export async function runInteractiveInit(cwd: string, ui: InitPrompt, forceCustom = false): Promise<InitOnboardingOutcome> {
  ui.intro("Ariadne project setup");
  try {
    const configPath = path.join(cwd, "ariadne.yml");
    const exists = await fs.pathExists(configPath);
    let mode: "default" | "custom";
    if (exists) {
      ui.note(configPath, "An Ariadne configuration already exists");
      const action = await ui.select({
        message: "How would you like to continue?",
        choices: [
          { value: "validate", label: "Validate existing configuration" },
          { value: "default", label: "Replace using Default setup", hint: "shows a diff and creates a backup" },
          { value: "custom", label: "Replace using Custom setup", hint: "shows a diff and creates a backup" },
          { value: "cancel", label: "Cancel" }
        ],
        initialValue: "validate"
      });
      if (action === "validate") return validateExisting(ui, cwd);
      if (action === "cancel") throw new InitCancelled();
      mode = action;
    } else if (forceCustom) {
      mode = "custom";
    } else {
      mode = await ui.select({
        message: "How would you like to configure this project?",
        choices: [
          { value: "default", label: "Default", hint: "recommended repository-aware settings" },
          { value: "custom", label: "Custom", hint: "review every workflow and safety setting" }
        ],
        initialValue: "default"
      });
    }
    ui.start("Inspecting repository...");
    const detection = await detectRepository(cwd);
    ui.stop("Repository inspected");
    showDetection(ui, detection);
    let proposal: InitProposal;
    if (mode === "custom") {
      proposal = await buildReviewedCustomProposal(ui, cwd, detection);
    } else {
      proposal = await buildInitProposal(cwd, detection, defaultInitSettings(detection));
      ui.note(formatProposalFiles(proposal), proposal.replacement ? "Replacement file plan" : "File plan");
      if (proposal.replacement) ui.note(formatProposalDiff(proposal), "Required replacement diff");
      const confirmed = await ui.confirm({ message: proposal.replacement ? "Replace configuration with a validated backup?" : "Create configuration?", initialValue: !proposal.replacement });
      if (!confirmed) throw new InitCancelled();
    }
    return await writeProposal(ui, cwd, proposal);
  } catch (error) {
    if (error instanceof InitCancelled) {
      ui.cancel("Operation cancelled. No files were changed.");
      throw error;
    }
    throw error;
  }
}

async function createClackPrompt(): Promise<InitPrompt> {
  if (!process.stdout.columns || process.stdout.columns < 40) process.stdout.columns = 80;
  if (!process.stdout.rows || process.stdout.rows < 10) process.stdout.rows = 24;
  const prompts = await import("@clack/prompts");
  const activeSpinner = prompts.spinner();
  const checked = <T>(value: T | symbol): T => {
    if (prompts.isCancel(value)) throw new InitCancelled();
    return value;
  };
  return {
    intro: prompts.intro,
    outro: prompts.outro,
    cancel: prompts.cancel,
    note: prompts.note,
    info: prompts.log.info,
    success: prompts.log.success,
    warning: prompts.log.warning,
    start: activeSpinner.start,
    stop: (message, success = true) => activeSpinner.stop(message, success ? 0 : 1),
    select: async (options) => checked(await prompts.select({ message: options.message, options: options.choices as never, initialValue: options.initialValue })),
    multiselect: async (options) => checked(await prompts.multiselect({ message: options.message, options: options.choices as never, initialValues: options.initialValues, required: options.required })),
    confirm: async (options) => checked(await prompts.confirm(options)),
    text: async (options) => checked(await prompts.text(options))
  };
}

export async function initOnboardingCommand(cwd: string, options: InitOnboardingOptions): Promise<InitOnboardingOutcome> {
  if (options.interactive) {
    if (options.color === false) process.env.NO_COLOR = process.env.NO_COLOR || "1";
    try {
      const prompt = await createClackPrompt();
      const themeEnabled = options.color !== false && (!process.env.NO_COLOR || Boolean(process.env.FORCE_COLOR));
      return await withAriadneTerminalTheme(themeEnabled, () => runInteractiveInit(cwd, prompt, options.custom));
    } catch (error) {
      if (error instanceof InitCancelled) return {
        kind: "skipped",
        result: {
          config: "skipped",
          task: "skipped",
          tasks: { created: [], skipped: [] },
          runsDirectory: "untouched",
          batchesDirectory: "untouched",
          worktreesDirectory: "untouched",
          promotionsDirectory: "untouched",
          gitignore: "unchanged",
          configurationValidated: false
        }
      };
      throw error;
    }
  }
  if (options.custom) throw new Error("Custom setup requires an interactive terminal.");
  if (await fs.pathExists(path.join(cwd, "ariadne.yml"))) {
    const result = await initCommand(cwd);
    if (!options.quiet) process.stderr.write(`Ariadne configuration already exists: ${path.join(cwd, "ariadne.yml")}\nNothing was changed. Run ariadne init in an interactive terminal to validate or replace it.\n`);
    return { kind: "skipped", result };
  }
  if (!options.repositoryAware) return { kind: "created", result: await initCommand(cwd), doctor: await diagnoseRepository(cwd), taskIds: ["example"] };
  const detection = await detectRepository(cwd);
  const proposal = await buildInitProposal(cwd, detection, defaultInitSettings(detection));
  const result = await applyInitProposal(cwd, proposal);
  return { kind: "created", result, doctor: await diagnoseRepository(cwd), taskIds: proposal.taskIds };
}
