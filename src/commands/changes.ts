import path from "node:path";
import fs from "fs-extra";
import { AriadneError } from "../core/errors.js";
import { sanitizeTerminalText, wrapHostileLines } from "../core/terminal-sanitize.js";
import {
  applyResult, discardReviewedResult, exportPatch,
  loadBoundedResultPreview, loadResultSummary, previewPatchExport
} from "../core/change-application.js";
import { loadManagedRun, promotionStatus } from "../core/promotion.js";
import type { PromotionRecord } from "../types/index.js";

function formatChanges(view: Awaited<ReturnType<typeof changesView>>): string {
  const lines = [
    "Ariadne changes", `Run: ${view.runId}`, `State: ${view.state}`, `Applicable: ${view.applicable ? "yes" : "no"}`,
    `Source: ${view.sourceRevision}`, `Prepared: ${view.preparedRevision}`, `Result: ${view.resultRevision ?? "none"}`,
    `Promotion: ${view.promotion}`, "", "TYPE  PATH  LINES"
  ];
  for (const change of view.changes) lines.push(`${change.changeType}  ${change.path}  ${change.binary ? "binary" : `${change.additions ?? 0}+/${change.deletions ?? 0}-`}`);
  for (const omitted of view.omittedSensitive) lines.push(`OMITTED  ${omitted.path}  ${omitted.reason}${omitted.rule ? ` (${omitted.rule})` : ""}`);
  if (view.changes.length === 0 && view.omittedSensitive.length === 0) lines.push("none");
  if (view.ineligibleReason) lines.push("", `Ineligible: ${view.ineligibleReason}`);
  return wrapHostileLines(lines.join("\n"), 240);
}

export async function changesView(cwd: string, idOrPath: string) {
  const summary = await loadResultSummary(cwd, idOrPath);
  const run = await loadManagedRun(cwd, idOrPath);
  if (!run.changeArtifact) throw new AriadneError({ category: "promotion_conflict", code: "CHANGE_ARTIFACT_MISSING", stage: "loading", message: `Run ${run.runId} has no isolated change artifact.` });
  const status = await promotionStatus(cwd, idOrPath);
  return {
    kind: "changes" as const, runId: run.runId, state: run.changeArtifact.state, applicable: run.changeArtifact.applicable,
    sourceRevision: run.changeArtifact.sourceRevision, preparedRevision: run.changeArtifact.preparedRevision,
    resultRevision: run.changeArtifact.resultRevision, resultRef: run.changeArtifact.resultRef,
    changes: run.changeArtifact.changes, omittedSensitive: run.changeArtifact.omittedSensitive,
    ineligibleReason: run.changeArtifact.ineligibleReason, promotion: status.promotion,
    workspace: run.workspace, resultState: summary.result.resultState
  };
}

export async function changesCommand(cwd: string, idOrPath: string, json = false): Promise<void> {
  const view = await changesView(cwd, idOrPath);
  process.stdout.write(json ? `${JSON.stringify(view, null, 2)}\n` : `${formatChanges(view)}\n`);
}

export async function diffCommand(cwdInput: string, idOrPath: string, output?: string, json = false, force = false): Promise<void> {
  const cwd = await fs.realpath(cwdInput).catch(() => path.resolve(cwdInput));
  const { runId, preview } = await loadBoundedResultPreview(cwd, idOrPath);
  let outputPath: string | undefined;
  if (output) {
    const exported = await exportPatch(cwd, idOrPath, output, force);
    outputPath = exported.path;
  }
  const safePreview = wrapHostileLines(preview, 240);
  process.stdout.write(json ? `${JSON.stringify({ kind: "diff", runId, preview, outputPath }, null, 2)}\n` : safePreview.endsWith("\n") ? safePreview : `${safePreview}\n`);
  if (outputPath && !json) process.stderr.write(`Complete safe patch written: ${sanitizeTerminalText(outputPath)}\n`);
}

export { previewPatchExport };

export async function statusCommand(cwd: string, idOrPath: string, json = false): Promise<void> {
  const status = await promotionStatus(cwd, idOrPath);
  process.stdout.write(json ? `${JSON.stringify(status, null, 2)}\n` : `Ariadne result status\nRun: ${sanitizeTerminalText(status.runId)}\nApplicable: ${status.applicable ? "yes" : "no"}\nPromotion: ${status.promotion}\nEvents: ${status.events.length}\n`);
}

function formatPromotion(record: PromotionRecord): string {
  return wrapHostileLines(`Ariadne ${record.kind}\nPromotion: ${record.promotionId}\nRun: ${record.runId}\nStatus: ${record.status}\nIncluded runs: ${record.includedRunIds.join(", ")}\n${record.conflictPaths.length ? `Conflicts: ${record.conflictPaths.join(", ")}\n` : ""}`, 240);
}

export async function applyCommand(cwd: string, idOrPath: string, json = false): Promise<PromotionRecord> {
  const result = await applyResult(cwd, idOrPath);
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : formatPromotion(result));
  return result;
}

export async function discardCommand(cwd: string, idOrPath: string, json = false): Promise<PromotionRecord> {
  const result = await discardReviewedResult(cwd, idOrPath);
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : formatPromotion(result));
  return result;
}
