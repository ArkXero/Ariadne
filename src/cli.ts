#!/usr/bin/env node
import { Command } from "commander";
import { doctorCommand } from "./commands/doctor.js";
import { initCommand } from "./commands/init.js";
import { listCommand } from "./commands/list.js";
import { reportCommand } from "./commands/report.js";
import { runCommand } from "./commands/run.js";

const program = new Command();
const argv = process.argv[2] === "--"
  ? [...process.argv.slice(0, 2), ...process.argv.slice(3)]
  : process.argv;

program
  .name("ariadne")
  .description("Run local coding-agent reliability evals and generate reports.")
  .version("0.1.0");

program
  .command("init")
  .description("Create Ariadne config, example task, and run directory.")
  .action(async () => {
    await initCommand(process.cwd());
  });

program
  .command("doctor")
  .description("Validate Ariadne configuration and commands before a run.")
  .option("-c, --config <path>", "Path to Ariadne config file.", "ariadne.yml")
  .action(async (options: { config: string }) => {
    await doctorCommand(process.cwd(), options.config);
  });

program
  .command("run")
  .description("Run configured eval tasks against the configured agent command.")
  .option("-c, --config <path>", "Path to Ariadne config file.", "ariadne.yml")
  .action(async (options: { config: string }) => {
    await runCommand(process.cwd(), options.config);
  });

program
  .command("list")
  .description("List all Ariadne runs in this project.")
  .action(async () => {
    await listCommand(process.cwd());
  });

program
  .command("report")
  .description("Print latest run summary and generate an HTML report.")
  .option("-r, --run <path>", "Path to a specific run JSON file.")
  .action(async (options: { run?: string }) => {
    await reportCommand(process.cwd(), options.run);
  });

try {
  await program.parseAsync(argv);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
