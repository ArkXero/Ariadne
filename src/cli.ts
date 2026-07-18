#!/usr/bin/env node
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { doctorCommand } from "./commands/doctor.js";
import { formatInitResult, initOnboardingCommand, initOutcomeJson } from "./commands/init.js";
import { listCommand, type ListFormat } from "./commands/list.js";
import { reportCommand } from "./commands/report.js";
import { exitCodeForBatch, runCommand } from "./commands/run.js";
import { planCommand } from "./commands/plan.js";
import { resumeCommand } from "./commands/resume.js";
import { rerunCommand } from "./commands/rerun.js";
import { applyCommand, changesCommand, diffCommand, discardCommand, statusCommand } from "./commands/changes.js";
import { worktreeCleanCommand, worktreeListCommand, worktreeRemoveCommand } from "./commands/worktree.js";
import { tuiCommand } from "./commands/tui.js";
import { AriadneError, formatAriadneError } from "./core/errors.js";
import { getAriadneVersion } from "./core/version.js";
import type { FailureMode, IsolationStrategy } from "./types/index.js";

interface GlobalOptions {
  verbose?: boolean;
  quiet?: boolean;
  json?: boolean;
  color?: boolean;
}

function exitCodeForError(error: unknown): number {
  if (error instanceof InvalidArgumentError) return 2;
  if (!(error instanceof AriadneError)) return 70;
  if (error.category === "configuration" || error.category === "task_loading") return 2;
  if (error.category === "task_selection") return 3;
  if (error.category === "repository_validation") return 4;
  if (error.category === "workspace_preparation" || error.category === "workspace_management") return 14;
  if (error.category === "promotion_conflict") return 15;
  return 70;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseFormat(value: string): ListFormat {
  if (["compact", "wide", "json", "csv", "markdown"].includes(value)) return value as ListFormat;
  throw new InvalidArgumentError("Format must be compact, wide, json, csv, or markdown.");
}

function parseConcurrency(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 32) throw new InvalidArgumentError("Concurrency must be an integer from 1 through 32.");
  return parsed;
}

function parseFailureMode(value: string): FailureMode {
  if (value === "continue" || value === "fail-fast") return value;
  throw new InvalidArgumentError("Failure mode must be continue or fail-fast.");
}

function parseIsolation(value: string): IsolationStrategy {
  if (value === "shared" || value === "worktree") return value;
  throw new InvalidArgumentError("Isolation must be shared or worktree.");
}

function selectedIds(positional: string[], repeated: string[], all?: boolean): string[] | undefined {
  const values = [...positional, ...repeated];
  if (all && values.length > 0) throw new InvalidArgumentError("--all cannot be combined with task IDs or --task.");
  const seen = new Set<string>();
  const result = values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return result.length > 0 ? result : undefined;
}

const program = new Command();
const argv = process.argv[2] === "--" ? [...process.argv.slice(0, 2), ...process.argv.slice(3)] : process.argv;

program.configureHelp({ showGlobalOptions: true });
program.exitOverride();

program
  .name("ariadne")
  .description("Run local coding-agent reliability evals and generate reports.")
  .version(await getAriadneVersion())
  .option("--verbose", "Include stack traces and deeper diagnostics.")
  .option("--quiet", "Suppress progress and warning output.")
  .option("--json", "Write machine-readable JSON to stdout.")
  .option("--no-color", "Disable color and styled text output.")
  .hook("preAction", (command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    if (options.verbose && options.quiet) throw new InvalidArgumentError("--verbose and --quiet cannot be used together.");
  });

program.command("init").description("Configure Ariadne with repository-aware default or custom setup.")
  .option("-y, --yes", "Accept detected defaults without prompting.")
  .option("--custom", "Open Custom setup immediately (interactive terminals only).")
  .action(async (local: { yes?: boolean; custom?: boolean }, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    if (local.yes && local.custom) throw new InvalidArgumentError("--yes and --custom cannot be combined.");
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && !options.json && !local.yes);
    if (local.custom && !interactive) throw new InvalidArgumentError("--custom requires an interactive terminal.");
    const outcome = await initOnboardingCommand(process.cwd(), {
      interactive,
      repositoryAware: interactive || Boolean(local.yes),
      custom: local.custom,
      json: options.json,
      quiet: options.quiet,
      color: options.color
    });
    if (interactive) {
      if ("doctor" in outcome && !outcome.doctor.passed) process.exitCode = 2;
      return;
    }
    if (options.json) process.stdout.write(`${JSON.stringify(initOutcomeJson(outcome), null, 2)}\n`);
    else if (!options.quiet && "result" in outcome) process.stdout.write(`${formatInitResult(outcome.result)}\n`);
    if ("doctor" in outcome && !outcome.doctor.passed) process.exitCode = 2;
  });

program.command("doctor").description("Validate Ariadne configuration and commands before a run.")
  .option("-c, --config <path>", "Path to Ariadne config file.", "ariadne.yml")
  .action(async (local: { config: string }, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    const report = await doctorCommand(process.cwd(), local.config, options.json, options.verbose);
    if (!report.passed) process.exitCode = 2;
  });

program.command("plan [taskIds...]").description("Build a deterministic workflow plan without executing tasks.")
  .option("-c, --config <path>", "Path to Ariadne config file.", "ariadne.yml")
  .option("--all", "Plan all configured tasks.")
  .option("--concurrency <n>", "Override workflow concurrency (1..32).", parseConcurrency)
  .option("--failure-mode <mode>", "continue or fail-fast", parseFailureMode)
  .option("--isolation <mode>", "shared or worktree", parseIsolation)
  .option("--allow-dirty-base", "Acknowledge that worktree isolation excludes uncommitted primary-checkout changes.")
  .action(async (taskIds: string[], local: { config: string; all?: boolean; concurrency?: number; failureMode?: FailureMode; isolation?: IsolationStrategy; allowDirtyBase?: boolean }, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    await planCommand({ cwd: process.cwd(), configPath: local.config, taskIds: selectedIds(taskIds, [], local.all), concurrency: local.concurrency, failureMode: local.failureMode, isolation: local.isolation, allowDirtyBase: local.allowDirtyBase, json: options.json, quiet: options.quiet });
  });

program.command("run [taskIds...]").description("Plan and run a local task workflow.")
  .option("-c, --config <path>", "Path to Ariadne config file.", "ariadne.yml")
  .option("-t, --task <id>", "Run one task ID; repeat to select multiple tasks.", collect, [])
  .option("--all", "Run all configured tasks.")
  .option("--concurrency <n>", "Override workflow concurrency (1..32).", parseConcurrency)
  .option("--failure-mode <mode>", "continue or fail-fast", parseFailureMode)
  .option("--isolation <mode>", "shared or worktree", parseIsolation)
  .option("--allow-dirty-base", "Acknowledge that worktree isolation excludes uncommitted primary-checkout changes.")
  .action(async (taskIds: string[], local: { config: string; task: string[]; all?: boolean; concurrency?: number; failureMode?: FailureMode; isolation?: IsolationStrategy; allowDirtyBase?: boolean }, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    const result = await runCommand({ cwd: process.cwd(), configPath: local.config, taskIds: selectedIds(taskIds, local.task, local.all), concurrency: local.concurrency, failureMode: local.failureMode, isolation: local.isolation, allowDirtyBase: local.allowDirtyBase, json: options.json, quiet: options.quiet });
    process.exitCode = exitCodeForBatch(result.batch, result.signal);
  });

program.command("resume <batchId>").description("Continue a compatible interrupted, incomplete, or retry-eligible batch.")
  .option("-c, --config <path>", "Path to Ariadne config file.")
  .option("--concurrency <n>", "Override workflow concurrency (1..32).", parseConcurrency)
  .option("--allow-dirty-base", "Acknowledge excluded dirty primary-checkout changes.")
  .action(async (batchId: string, local: { config?: string; concurrency?: number; allowDirtyBase?: boolean }, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    const result = await resumeCommand({ cwd: process.cwd(), batchId, configPath: local.config, concurrency: local.concurrency, allowDirtyBase: local.allowDirtyBase, json: options.json, quiet: options.quiet });
    process.exitCode = exitCodeForBatch(result.batch, result.signal);
  });

program.command("rerun <batchId>").description("Create a new batch from selected results of an earlier batch.")
  .option("-c, --config <path>", "Path to Ariadne config file.")
  .option("--failed", "Rerun failed tasks and their dependency closure.")
  .option("--blocked", "Rerun blocked tasks and their dependency closure.")
  .option("--all", "Rerun the source batch selected roots.")
  .option("-t, --task <id>", "Rerun a task from the source batch; repeatable.", collect, [])
  .option("--concurrency <n>", "Override workflow concurrency (1..32).", parseConcurrency)
  .option("--failure-mode <mode>", "continue or fail-fast", parseFailureMode)
  .option("--isolation <mode>", "shared or worktree", parseIsolation)
  .option("--allow-dirty-base", "Acknowledge that worktree isolation excludes uncommitted primary-checkout changes.")
  .action(async (batchId: string, local: { config?: string; failed?: boolean; blocked?: boolean; all?: boolean; task: string[]; concurrency?: number; failureMode?: FailureMode; isolation?: IsolationStrategy; allowDirtyBase?: boolean }, command: Command) => {
    const choices = [local.failed && "failed", local.blocked && "blocked", local.all && "all", local.task.length > 0 && "tasks"].filter(Boolean) as Array<"failed" | "blocked" | "all" | "tasks">;
    if (choices.length !== 1) throw new InvalidArgumentError("Choose exactly one of --failed, --blocked, --all, or --task.");
    const options = command.optsWithGlobals<GlobalOptions>();
    const result = await rerunCommand({ cwd: process.cwd(), batchId, configPath: local.config, mode: choices[0], taskIds: local.task, concurrency: local.concurrency, failureMode: local.failureMode, isolation: local.isolation, allowDirtyBase: local.allowDirtyBase, json: options.json, quiet: options.quiet });
    process.exitCode = exitCodeForBatch(result.batch, result.signal);
  });

program.command("list").description("List task-attempt or workflow-batch history.")
  .option("--format <format>", "compact, wide, json, csv, or markdown", parseFormat)
  .option("--wide", "Alias for --format wide.")
  .option("--csv", "Alias for --format csv.")
  .option("--md", "Alias for --format markdown.")
  .option("--tasks", "List task-attempt history (default).")
  .option("--batches", "List workflow batch history.")
  .option("--unapplied", "List applicable task results not yet applied or discarded.")
  .option("--applied", "List task results included in successful promotions.")
  .option("--discarded", "List discarded task results.")
  .option("-o, --output <path>", "Also write the rendered output to this project-relative path.")
  .action(async (local: { format?: ListFormat; wide?: boolean; csv?: boolean; md?: boolean; tasks?: boolean; batches?: boolean; output?: string; unapplied?: boolean; applied?: boolean; discarded?: boolean }, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    const aliases = [local.wide && "wide", local.csv && "csv", local.md && "markdown", options.json && "json"].filter(Boolean) as ListFormat[];
    if (aliases.length + (local.format ? 1 : 0) > 1) throw new InvalidArgumentError("Choose only one list format.");
    if (local.tasks && local.batches) throw new InvalidArgumentError("Choose only one of --tasks or --batches.");
    const promotionFilters = [local.unapplied && "unapplied", local.applied && "applied", local.discarded && "discarded"].filter(Boolean) as Array<"unapplied" | "applied" | "discarded">;
    if (promotionFilters.length > 1) throw new InvalidArgumentError("Choose only one of --unapplied, --applied, or --discarded.");
    if (local.batches && promotionFilters.length) throw new InvalidArgumentError("Promotion filters apply only to task-run history.");
    await listCommand(process.cwd(), { format: local.format ?? aliases[0], output: local.output, quiet: options.quiet, kind: local.batches ? "batches" : "tasks", promotion: promotionFilters[0] });
  });

program.command("report").description("Print a task or workflow summary and generate offline HTML.")
  .option("-r, --run <id-or-path>", "Run ID or path to a run JSON file.")
  .option("-b, --batch <id-or-path>", "Batch ID or path to a batch JSON file.")
  .option("-o, --output <path>", "Project-relative HTML output path.")
  .action(async (local: { run?: string; batch?: string; output?: string }, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    if (local.run && local.batch) throw new InvalidArgumentError("Choose only one of --run or --batch.");
    await reportCommand({ cwd: process.cwd(), runPath: local.run, batchPath: local.batch, outputPath: local.output, json: options.json, quiet: options.quiet });
  });

program.command("tui").description("Open the keyboard-first Ariadne workflow TUI.")
  .action(async (_local: unknown, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    if (options.json) throw new InvalidArgumentError("--json cannot be used with the interactive tui command.");
    if (options.quiet) throw new InvalidArgumentError("--quiet cannot be used with the interactive tui command.");
    await tuiCommand({ cwd: process.cwd(), verbose: options.verbose, color: options.color });
  });

program.command("changes <runIdOrPath>").description("Show the canonical safe-change view for an isolated task attempt.")
  .action(async (runIdOrPath: string, _local: unknown, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    await changesCommand(process.cwd(), runIdOrPath, options.json);
  });

program.command("diff <runIdOrPath>").description("Print a bounded text-safe change preview; optionally copy the complete safe binary patch.")
  .option("-o, --output <path>", "Project-relative destination for the complete safe binary patch.")
  .action(async (runIdOrPath: string, local: { output?: string }, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    await diffCommand(process.cwd(), runIdOrPath, local.output, options.json);
  });

program.command("status <runIdOrPath>").description("Show applicability, promotion state, and promotion history for a result.")
  .action(async (runIdOrPath: string, _local: unknown, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    await statusCommand(process.cwd(), runIdOrPath, options.json);
  });

program.command("apply <runIdOrPath>").description("Preflight and apply an eligible result closure as one commit on a clean named branch.")
  .action(async (runIdOrPath: string, _local: unknown, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    const result = await applyCommand(process.cwd(), runIdOrPath, options.json);
    if (result.status !== "succeeded") process.exitCode = 15;
  });

program.command("discard <runIdOrPath>").description("Discard an unapplied managed result ref while preserving historical artifacts.")
  .action(async (runIdOrPath: string, _local: unknown, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    const result = await discardCommand(process.cwd(), runIdOrPath, options.json);
    if (result.status !== "discarded") process.exitCode = 15;
  });

const worktree = program.command("worktree").description("Inspect and clean Ariadne-managed Git worktrees.");
worktree.command("list").description("List managed worktree metadata.")
  .action(async (_local: unknown, command: Command) => worktreeListCommand(process.cwd(), command.optsWithGlobals<GlobalOptions>().json));
worktree.command("remove <workspaceId>").description("Remove one positively identified managed worktree.")
  .action(async (workspaceId: string, _local: unknown, command: Command) => worktreeRemoveCommand(process.cwd(), workspaceId, command.optsWithGlobals<GlobalOptions>().json));
worktree.command("clean").description("Remove retained, stale, or failed managed worktrees.")
  .option("--dry-run", "Show exact cleanup actions without removing worktrees.")
  .action(async (local: { dryRun?: boolean }, command: Command) => worktreeCleanCommand(process.cwd(), local.dryRun, command.optsWithGlobals<GlobalOptions>().json));

try {
  await program.parseAsync(argv);
} catch (error) {
  if (error instanceof CommanderError && !(error instanceof InvalidArgumentError)) {
    process.exitCode = error.exitCode === 0 ? 0 : 2;
  } else {
    const options = program.opts<GlobalOptions>();
    const message = error instanceof AriadneError
      ? formatAriadneError(error, options.verbose)
      : error instanceof Error
        ? options.verbose && error.stack ? error.stack : error.message
        : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = exitCodeForError(error);
  }
}
