import path from "node:path";
import {
  formatCompactRunList,
  formatWideRunList,
  listRuns,
  writeRunCsv,
  writeRunJson,
  writeRunMarkdown
} from "../core/runs.js";

export interface ListOptions {
  wide?: boolean;
  csv?: boolean;
  md?: boolean;
  json?: boolean;
}

function displayPath(cwd: string, outputPath: string): string {
  const relativePath = path.relative(cwd, outputPath);
  return relativePath.startsWith("..") ? outputPath : relativePath;
}

export async function listCommand(cwd: string, options: ListOptions = {}): Promise<void> {
  const selectedModes = [options.wide, options.csv, options.md, options.json].filter(Boolean);
  if (selectedModes.length > 1) {
    throw new Error("Choose only one output mode: --wide, --csv, --md, or --json.");
  }

  const runs = await listRuns(cwd);

  if (options.csv) {
    console.log(`CSV written: ${displayPath(cwd, await writeRunCsv(cwd, runs))}`);
  } else if (options.md) {
    console.log(`Markdown written: ${displayPath(cwd, await writeRunMarkdown(cwd, runs))}`);
  } else if (options.json) {
    console.log(`JSON written: ${displayPath(cwd, await writeRunJson(cwd, runs))}`);
  } else {
    console.log(options.wide ? formatWideRunList(runs) : formatCompactRunList(runs));
  }
}
