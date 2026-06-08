import path from "node:path";
import { loadConfig } from "../core/config.js";
import { formatRunList, listRuns, writeRunCsv } from "../core/runs.js";

export async function listCommand(cwd: string): Promise<void> {
  const { config } = await loadConfig(cwd);
  const runs = await listRuns(cwd);
  console.log(formatRunList(runs));

  if (config.list.csv.enabled) {
    const outputPath = await writeRunCsv(cwd, config.list.csv.path, runs);
    const displayPath = path.relative(cwd, outputPath);
    console.log(`\nCSV written: ${displayPath.startsWith("..") ? outputPath : displayPath}`);
  }
}
