import { runAriadne } from "../core/runner.js";

export async function runCommand(cwd: string, configPath: string): Promise<void> {
  const run = await runAriadne({ cwd, configPath });

  console.log(`Run written: ${run.outputPath}`);
  console.log(`Tasks: ${run.summary.total}, passed: ${run.summary.passed}, failed: ${run.summary.failed}`);

  if (run.summary.failed > 0) {
    process.exitCode = 1;
  }
}
