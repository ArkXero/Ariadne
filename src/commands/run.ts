import { runAriadne } from "../core/runner.js";
import { formatTerminalSummary } from "../core/report.js";

export async function runCommand(cwd: string, configPath: string): Promise<void> {
  const run = await runAriadne({ cwd, configPath });

  console.log(`Run written: ${run.outputPath}`);
  console.log(formatTerminalSummary(run));

  if (run.summary.failed > 0) {
    process.exitCode = 1;
  }
}
