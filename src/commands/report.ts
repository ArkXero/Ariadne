import path from "node:path";
import fs from "fs-extra";
import { atomicWriteFile } from "../core/atomic.js";
import { AriadneError } from "../core/errors.js";
import { buildHtmlReport, findLatestRunFile, formatTerminalSummary, loadRunReport } from "../core/report.js";
import { loadBatchFile, resolveBatchFile } from "../core/batch-reader.js";
import { buildBatchHtmlReport, buildBatchReportModel, formatBatchCompletion } from "../core/workflow-report.js";
import { canonicalizePath, isPathInside } from "../core/path-containment.js";
import { loadPromotions } from "../core/promotion.js";

export async function reportCommand(options: {
  cwd: string;
  runPath?: string;
  batchPath?: string;
  outputPath?: string;
  json?: boolean;
  quiet?: boolean;
}): Promise<{ outputPath: string }> {
  const projectRoot = await fs.realpath(options.cwd).catch(() => path.resolve(options.cwd));
  let batchSelection = options.batchPath;
  if (!options.runPath && !batchSelection) {
    const invocationPointer = path.join(projectRoot, ".ariadne", "latest.json");
    try {
      const pointer = await fs.readJson(invocationPointer) as { kind?: unknown; batchId?: unknown };
      if (pointer.kind === "batch" && typeof pointer.batchId === "string") batchSelection = pointer.batchId;
    } catch { /* retain task-run fallback */ }
  }
  if (batchSelection) {
    const batchPath = await resolveBatchFile(projectRoot, batchSelection);
    const loaded = await loadBatchFile(batchPath, projectRoot);
    if (!loaded.ok) throw new Error(loaded.error);
    const batchRunIds = new Set(loaded.batch.tasks.flatMap((task) => task.attempts.map((attempt) => attempt.runId)));
    const promotions = (await loadPromotions(projectRoot)).flatMap((item) => item.record && item.record.includedRunIds.some((runId) => batchRunIds.has(runId)) ? [item.record] : []);
    const model = buildBatchReportModel(loaded.batch, loaded.warnings, relative(projectRoot, batchPath), promotions);
    const defaultOutput = path.join(path.dirname(batchPath), "report.html");
    const outputPath = options.outputPath ? path.resolve(projectRoot, options.outputPath) : defaultOutput;
    if (!isPathInside(projectRoot, await canonicalizePath(outputPath))) throw new AriadneError({ category: "configuration", code: "OUTPUT_PATH_OUTSIDE_ROOT", stage: "validated", message: "Report output path must stay inside the project root.", fieldPath: "output", offendingValue: options.outputPath, expected: "A project-relative output path without traversal or escaping symlinks.", correction: "Choose an output path inside the invocation root." });
    await atomicWriteFile(outputPath, buildBatchHtmlReport(model));
    const latestBatchReport = path.join(projectRoot, ".ariadne", "batches", "latest-report.html");
    if (outputPath !== latestBatchReport) await atomicWriteFile(latestBatchReport, buildBatchHtmlReport(model));
    await atomicWriteFile(path.join(projectRoot, ".ariadne", "latest-report.html"), buildBatchHtmlReport(model));
    process.stdout.write(options.json ? `${JSON.stringify(model, null, 2)}\n` : `${formatBatchCompletion(loaded.batch)}\n`);
    if (!options.quiet) {
      for (const warning of loaded.warnings) process.stderr.write(`Warning: ${warning}\n`);
      process.stderr.write(`HTML report written: ${outputPath}\n`);
    }
    return { outputPath };
  }
  let resolvedRunPath: string;
  if (options.runPath) {
    const direct = path.resolve(projectRoot, options.runPath);
    const byId = path.join(projectRoot, ".ariadne", "runs", options.runPath, "run.json");
    resolvedRunPath = options.runPath.includes(path.sep) || options.runPath.endsWith(".json") ? direct : byId;
  } else {
    resolvedRunPath = await findLatestRunFile(projectRoot);
  }
  const canonicalRunPath = await canonicalizePath(resolvedRunPath);
  if (!isPathInside(projectRoot, canonicalRunPath)) {
    throw new AriadneError({
      category: "configuration",
      code: "RUN_PATH_OUTSIDE_ROOT",
      stage: "validated",
      message: "Run record path must stay inside the project root.",
      fieldPath: "run",
      offendingValue: options.runPath,
      expected: "A run ID or project-relative path without traversal or escaping symlinks.",
      correction: "Choose a run record inside the invocation root."
    });
  }
  const model = await loadRunReport(resolvedRunPath);
  model.promotions = (await loadPromotions(projectRoot)).flatMap((item) => item.record && (item.record.runId === model.runId || item.record.includedRunIds.includes(model.runId)) ? [item.record] : []);
  model.manifestPath = path.relative(projectRoot, resolvedRunPath).split(path.sep).join("/");
  const defaultOutput = path.basename(resolvedRunPath) === "run.json"
    ? path.join(path.dirname(resolvedRunPath), "report.html")
    : path.join(projectRoot, ".ariadne", "runs", "latest-report.html");
  const outputPath = options.outputPath ? path.resolve(projectRoot, options.outputPath) : defaultOutput;
  if (!isPathInside(projectRoot, await canonicalizePath(outputPath))) {
    throw new AriadneError({
      category: "configuration",
      code: "OUTPUT_PATH_OUTSIDE_ROOT",
      stage: "validated",
      message: "Report output path must stay inside the project root.",
      fieldPath: "output",
      offendingValue: options.outputPath,
      expected: "A project-relative output path without traversal or escaping symlinks.",
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

function relative(root: string, value: string): string {
  return path.relative(root, value).split(path.sep).join("/");
}
