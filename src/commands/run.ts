import { runAriadne } from "../core/runner.js";
import { formatRunCompletion } from "../core/report.js";

export async function runCommand(cwd: string, configPath: string): Promise<void> {
  const run = await runAriadne({ cwd, configPath });

  console.log(formatRunCompletion(run));

  if (run.summary.failed > 0) {
    process.exitCode = 1;
  }
}
