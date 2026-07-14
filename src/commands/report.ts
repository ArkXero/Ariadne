import path from "node:path";
import fs from "fs-extra";
import { atomicWriteFile } from "../core/atomic.js";
import { AriadneError } from "../core/errors.js";
import { buildHtmlReport, findLatestRunFile, formatTerminalSummary, loadRunReport } from "../core/report.js";

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function reportCommand(options: {
  cwd: string;
  runPath?: string;
  outputPath?: string;
  json?: boolean;
  quiet?: boolean;
}): Promise<{ outputPath: string }> {
  const projectRoot = await fs.realpath(options.cwd).catch(() => path.resolve(options.cwd));
  let resolvedRunPath: string;
  if (options.runPath) {
    const direct = path.resolve(projectRoot, options.runPath);
    const byId = path.join(projectRoot, ".ariadne", "runs", options.runPath, "run.json");
    resolvedRunPath = options.runPath.includes(path.sep) || options.runPath.endsWith(".json") ? direct : byId;
  } else {
    resolvedRunPath = await findLatestRunFile(projectRoot);
  }
  const model = await loadRunReport(resolvedRunPath);
  model.manifestPath = path.relative(projectRoot, resolvedRunPath).split(path.sep).join("/");
  const defaultOutput = path.basename(resolvedRunPath) === "run.json"
    ? path.join(path.dirname(resolvedRunPath), "report.html")
    : path.join(projectRoot, ".ariadne", "runs", "latest-report.html");
  const outputPath = options.outputPath ? path.resolve(projectRoot, options.outputPath) : defaultOutput;
  if (!inside(projectRoot, outputPath)) {
    throw new AriadneError({
      category: "configuration",
      code: "OUTPUT_PATH_OUTSIDE_ROOT",
      stage: "validated",
      message: "Report output path must stay inside the project root.",
      fieldPath: "output",
      offendingValue: options.outputPath,
      expected: "A project-relative output path without traversal.",
      correction: "Choose an output path inside the invocation root."
    });
  }
  await atomicWriteFile(outputPath, buildHtmlReport(model));
  const latestReport = path.join(projectRoot, ".ariadne", "runs", "latest-report.html");
  if (outputPath !== latestReport) await atomicWriteFile(latestReport, buildHtmlReport(model));
  process.stdout.write(options.json ? `${JSON.stringify(model, null, 2)}\n` : `${formatTerminalSummary(model)}\n`);
  if (!options.quiet) process.stderr.write(`HTML report written: ${outputPath}\n`);
  return { outputPath };
}
