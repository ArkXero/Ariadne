#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import { doctorCommand } from "./commands/doctor.js";
import { formatInitResult, initCommand } from "./commands/init.js";
import { listCommand, type ListFormat } from "./commands/list.js";
import { reportCommand } from "./commands/report.js";
import { exitCodeForRun, runCommand } from "./commands/run.js";
import { AriadneError, formatAriadneError } from "./core/errors.js";
import { getAriadneVersion } from "./core/version.js";

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
  return 70;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseFormat(value: string): ListFormat {
  if (["compact", "wide", "json", "csv", "markdown"].includes(value)) return value as ListFormat;
  throw new InvalidArgumentError("Format must be compact, wide, json, csv, or markdown.");
}

const program = new Command();
const argv = process.argv[2] === "--" ? [...process.argv.slice(0, 2), ...process.argv.slice(3)] : process.argv;

program.configureHelp({ showGlobalOptions: true });

program
  .name("ariadne")
  .description("Run local coding-agent reliability evals and generate reports.")
  .version(await getAriadneVersion())
  .option("--verbose", "Include stack traces and deeper diagnostics.")
  .option("--quiet", "Suppress progress and warning output.")
  .option("--json", "Write machine-readable JSON to stdout.")
  .option("--no-color", "Disable color output (output is ANSI-free in this release).")
  .hook("preAction", (command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    if (options.verbose && options.quiet) throw new InvalidArgumentError("--verbose and --quiet cannot be used together.");
  });

program.command("init").description("Create Ariadne config, example task, and run directory.").action(async (_, command: Command) => {
  const options = command.optsWithGlobals<GlobalOptions>();
  const result = await initCommand(process.cwd());
  process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatInitResult(result)}\n`);
});

program.command("doctor").description("Validate Ariadne configuration and commands before a run.")
  .option("-c, --config <path>", "Path to Ariadne config file.", "ariadne.yml")
  .action(async (local: { config: string }, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    const report = await doctorCommand(process.cwd(), local.config, options.json, options.verbose);
    if (!report.passed) process.exitCode = 2;
  });

program.command("run").description("Run configured eval tasks against the configured agent command.")
  .option("-c, --config <path>", "Path to Ariadne config file.", "ariadne.yml")
  .option("-t, --task <id>", "Run one task ID; repeat to select multiple tasks.", collect, [])
  .action(async (local: { config: string; task: string[] }, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    const result = await runCommand({ cwd: process.cwd(), configPath: local.config, taskIds: local.task, json: options.json, quiet: options.quiet });
    process.exitCode = exitCodeForRun(result.run, result.signal);
  });

program.command("list").description("List Ariadne run history.")
  .option("--format <format>", "compact, wide, json, csv, or markdown", parseFormat)
  .option("--wide", "Alias for --format wide.")
  .option("--csv", "Alias for --format csv.")
  .option("--md", "Alias for --format markdown.")
  .option("-o, --output <path>", "Also write the rendered output to this project-relative path.")
  .action(async (local: { format?: ListFormat; wide?: boolean; csv?: boolean; md?: boolean; output?: string }, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    const aliases = [local.wide && "wide", local.csv && "csv", local.md && "markdown", options.json && "json"].filter(Boolean) as ListFormat[];
    if (aliases.length + (local.format ? 1 : 0) > 1) throw new InvalidArgumentError("Choose only one list format.");
    await listCommand(process.cwd(), { format: local.format ?? aliases[0], output: local.output, quiet: options.quiet });
  });

program.command("report").description("Print a run summary and generate an offline HTML report.")
  .option("-r, --run <id-or-path>", "Run ID or path to a run JSON file.")
  .option("-o, --output <path>", "Project-relative HTML output path.")
  .action(async (local: { run?: string; output?: string }, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    await reportCommand({ cwd: process.cwd(), runPath: local.run, outputPath: local.output, json: options.json, quiet: options.quiet });
  });

try {
  await program.parseAsync(argv);
} catch (error) {
  const options = program.opts<GlobalOptions>();
  const message = error instanceof AriadneError
    ? formatAriadneError(error, options.verbose)
    : error instanceof Error
      ? options.verbose && error.stack ? error.stack : error.message
      : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = exitCodeForError(error);
}
