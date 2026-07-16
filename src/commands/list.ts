import {
  formatCompactRunList,
  formatRunCsv,
  formatRunJson,
  formatRunMarkdown,
  formatWideRunList,
  listRuns,
  writeRunOutput
} from "../core/runs.js";
import { formatBatchCsv, formatBatchJson, formatBatchMarkdown, formatCompactBatchList, formatWideBatchList, listBatches } from "../core/batches.js";

export type ListFormat = "compact" | "wide" | "json" | "csv" | "markdown";

export interface ListOptions {
  format?: ListFormat;
  output?: string;
  quiet?: boolean;
  kind?: "tasks" | "batches";
  promotion?: "unapplied" | "applied" | "discarded";
}

export async function listCommand(cwd: string, options: ListOptions = {}): Promise<{ warnings: string[]; outputPath?: string }> {
  const batchMode = options.kind === "batches";
  const format = options.format ?? "compact";
  let contents: string;
  let warnings: string[];
  if (batchMode) {
    const result = await listBatches(cwd);
    warnings = result.warnings;
    contents = format === "wide" ? formatWideBatchList(result.batches)
      : format === "json" ? formatBatchJson(result.batches)
        : format === "csv" ? formatBatchCsv(result.batches)
          : format === "markdown" ? formatBatchMarkdown(result.batches)
            : `${formatCompactBatchList(result.batches)}\n`;
  } else {
    const result = await listRuns(cwd, options.promotion);
    warnings = result.warnings;
    contents = format === "wide" ? formatWideRunList(result.runs)
      : format === "json" ? formatRunJson(result.runs)
        : format === "csv" ? formatRunCsv(result.runs)
          : format === "markdown" ? formatRunMarkdown(result.runs)
            : `${formatCompactRunList(result.runs)}\n`;
  }
  let outputPath: string | undefined;
  if (options.output) outputPath = await writeRunOutput(cwd, options.output, contents);
  process.stdout.write(contents.endsWith("\n") ? contents : `${contents}\n`);
  if (!options.quiet) {
    for (const warning of warnings) process.stderr.write(`Warning: ${warning}\n`);
    if (outputPath) process.stderr.write(`Output written: ${outputPath}\n`);
  }
  return { warnings, ...(outputPath ? { outputPath } : {}) };
}
