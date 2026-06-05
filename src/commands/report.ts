import path from "node:path";
import fs from "fs-extra";
import { buildHtmlReport, findLatestRunFile, formatTerminalSummary, loadRunReport } from "../core/report.js";

export async function reportCommand(cwd: string, runPath?: string): Promise<void> {
  const resolvedRunPath = runPath ? path.resolve(cwd, runPath) : await findLatestRunFile(cwd);
  const run = await loadRunReport(resolvedRunPath);
  const reportHtml = buildHtmlReport(run);
  const outputPath = path.join(cwd, ".ariadne", "runs", "latest-report.html");

  await fs.outputFile(outputPath, reportHtml);

  console.log(formatTerminalSummary(run));
  console.log(`HTML report written: ${outputPath}`);
}
