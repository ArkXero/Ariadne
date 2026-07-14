import {
  formatCompactRunList,
  formatRunCsv,
  formatRunJson,
  formatRunMarkdown,
  formatWideRunList,
  listRuns,
  writeRunOutput
} from "../core/runs.js";

export type ListFormat = "compact" | "wide" | "json" | "csv" | "markdown";

export interface ListOptions {
  format?: ListFormat;
  output?: string;
  quiet?: boolean;
}

export async function listCommand(cwd: string, options: ListOptions = {}): Promise<{ warnings: string[]; outputPath?: string }> {
  const result = await listRuns(cwd);
  const format = options.format ?? "compact";
  const contents = format === "wide" ? formatWideRunList(result.runs)
    : format === "json" ? formatRunJson(result.runs)
      : format === "csv" ? formatRunCsv(result.runs)
        : format === "markdown" ? formatRunMarkdown(result.runs)
          : `${formatCompactRunList(result.runs)}\n`;
  let outputPath: string | undefined;
  if (options.output) outputPath = await writeRunOutput(cwd, options.output, contents);
  process.stdout.write(contents.endsWith("\n") ? contents : `${contents}\n`);
  if (!options.quiet) {
    for (const warning of result.warnings) process.stderr.write(`Warning: ${warning}\n`);
    if (outputPath) process.stderr.write(`Output written: ${outputPath}\n`);
  }
  return { warnings: result.warnings, ...(outputPath ? { outputPath } : {}) };
}
