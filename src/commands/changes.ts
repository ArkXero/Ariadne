import path from "node:path";
import fs from "fs-extra";
import { atomicWriteFile } from "../core/atomic.js";
import { AriadneError } from "../core/errors.js";
import { canonicalizePath, isPathInside } from "../core/path-containment.js";
import { applyResult, discardResult, loadManagedRun, promotionStatus } from "../core/promotion.js";
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
  return lines.join("\n");
}

export async function changesView(cwd: string, idOrPath: string) {
  const run = await loadManagedRun(cwd, idOrPath);
  if (!run.changeArtifact) throw new AriadneError({ category: "promotion_conflict", code: "CHANGE_ARTIFACT_MISSING", stage: "loading", message: `Run ${run.runId} has no isolated change artifact.` });
  const status = await promotionStatus(cwd, idOrPath);
  return {
    kind: "changes" as const, runId: run.runId, state: run.changeArtifact.state, applicable: run.changeArtifact.applicable,
    sourceRevision: run.changeArtifact.sourceRevision, preparedRevision: run.changeArtifact.preparedRevision,
    resultRevision: run.changeArtifact.resultRevision, resultRef: run.changeArtifact.resultRef,
    changes: run.changeArtifact.changes, omittedSensitive: run.changeArtifact.omittedSensitive,
    ineligibleReason: run.changeArtifact.ineligibleReason, promotion: status.promotion,
    workspace: run.workspace
  };
}

export async function changesCommand(cwd: string, idOrPath: string, json = false): Promise<void> {
  const view = await changesView(cwd, idOrPath);
  process.stdout.write(json ? `${JSON.stringify(view, null, 2)}\n` : `${formatChanges(view)}\n`);
}

export async function diffCommand(cwdInput: string, idOrPath: string, output?: string, json = false): Promise<void> {
  const cwd = await fs.realpath(cwdInput).catch(() => path.resolve(cwdInput));
  const run = await loadManagedRun(cwd, idOrPath);
  if (!run.changeArtifact?.previewArtifact || !run.changeArtifact.patchArtifact) throw new AriadneError({ category: "promotion_conflict", code: "CHANGE_DIFF_MISSING", stage: "loading", message: `Run ${run.runId} has no safe diff artifact.` });
  const preview = await fs.readFile(path.resolve(cwd, run.changeArtifact.previewArtifact), "utf8").catch(() => { throw new AriadneError({ category: "persistence", code: "CHANGE_PREVIEW_MISSING", stage: "loading", message: "The bounded change preview artifact is missing." }); });
  let outputPath: string | undefined;
  if (output) {
    const resolved = path.resolve(cwd, output);
    if (!isPathInside(cwd, await canonicalizePath(resolved))) throw new AriadneError({ category: "configuration", code: "OUTPUT_PATH_OUTSIDE_ROOT", stage: "validated", message: "Output path must stay inside the project root." });
    await atomicWriteFile(resolved, await fs.readFile(path.resolve(cwd, run.changeArtifact.patchArtifact)));
    outputPath = path.relative(cwd, resolved).split(path.sep).join("/");
  }
  process.stdout.write(json ? `${JSON.stringify({ kind: "diff", runId: run.runId, preview, outputPath }, null, 2)}\n` : preview.endsWith("\n") ? preview : `${preview}\n`);
  if (outputPath && !json) process.stderr.write(`Complete safe patch written: ${outputPath}\n`);
}

export async function statusCommand(cwd: string, idOrPath: string, json = false): Promise<void> {
  const status = await promotionStatus(cwd, idOrPath);
  process.stdout.write(json ? `${JSON.stringify(status, null, 2)}\n` : `Ariadne result status\nRun: ${status.runId}\nApplicable: ${status.applicable ? "yes" : "no"}\nPromotion: ${status.promotion}\nEvents: ${status.events.length}\n`);
}

function formatPromotion(record: PromotionRecord): string {
  return `Ariadne ${record.kind}\nPromotion: ${record.promotionId}\nRun: ${record.runId}\nStatus: ${record.status}\nIncluded runs: ${record.includedRunIds.join(", ")}\n${record.conflictPaths.length ? `Conflicts: ${record.conflictPaths.join(", ")}\n` : ""}`;
}

export async function applyCommand(cwd: string, idOrPath: string, json = false): Promise<PromotionRecord> {
  const result = await applyResult(cwd, idOrPath);
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : formatPromotion(result));
  return result;
}

export async function discardCommand(cwd: string, idOrPath: string, json = false): Promise<PromotionRecord> {
  const result = await discardResult(cwd, idOrPath);
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : formatPromotion(result));
  return result;
}

