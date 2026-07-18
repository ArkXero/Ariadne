import path from "node:path";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { runWorkflow } from "../src/core/workflow-runner.js";
import {
  compareAttemptResults,
  applyReviewedResult,
  exportPatch,
  listReviewResults,
  loadFileDiff,
  loadResultSummary,
  previewPatchExport
} from "../src/core/change-application.js";
import { loadManagementActions } from "../src/core/management-actions.js";
import { discardResult, inspectApplyEligibility, loadPromotions } from "../src/core/promotion.js";
import {
  cleanWorkspace,
  listManagedWorkspaces,
  previewWorkspaceCleanup
} from "../src/core/workspace-application.js";
import { cleanupTempDirs, initGit, tempDir } from "./helpers.js";

afterEach(cleanupTempDirs);

async function fixture(options: { agent: string; retention?: "always" | "on-failure" | "never"; retry?: number }): Promise<string> {
  const cwd = await tempDir("ariadne-review-");
  await mkdir(path.join(cwd, ".ariadne", "tasks"), { recursive: true });
  await writeFile(path.join(cwd, ".gitignore"), [
    ".ariadne/runs/", ".ariadne/batches/", ".ariadne/worktrees/", ".ariadne/promotions/",
    ".ariadne/actions/", ".ariadne/exports/", ".ariadne/locks/", ".ariadne/latest.json"
  ].join("\n") + "\n");
  await writeFile(path.join(cwd, "agent.mjs"), options.agent);
  await writeFile(path.join(cwd, "target.txt"), "before\n");
  await writeFile(path.join(cwd, "ariadne.yml"), `version: 4
agent:
  command: {kind: exec, file: node, args: [agent.mjs]}
  timeout_ms: 5000
tasks: {directory: .ariadne/tasks}
verification: {commands: [], timeout_ms: 1000}
execution:
  termination_grace_ms: 100
  concurrency: 1
  failure_mode: continue
  isolation: worktree
  worktree:
    retention: ${options.retention ?? "never"}
    preparation: {commands: [], timeout_ms: 1000}
checks: {forbidden_files: [.env], forbidden_commands: []}
`);
  await writeFile(path.join(cwd, ".ariadne", "tasks", "review.yml"), `id: review
name: Review task
workspaceMode: mutable
retry: {attempts: ${options.retry ?? 1}, delayMs: 0, backoff: fixed}
prompt: review
`);
  await initGit(cwd, {});
  return cwd;
}

describe("change application service", () => {
  it("captures v2 file artifacts, pages bounded diffs, and exports without clobbering", async () => {
    const cwd = await fixture({
      agent: `import { writeFile } from "node:fs/promises"; await writeFile("large.txt", Array.from({length: 20000}, (_, index) => "line-" + index).join("\\n") + "\\n");`
    });
    const batch = await runWorkflow({ cwd });
    const attempt = batch.tasks[0]!.attempts[0]!;
    const record = JSON.parse(await readFile(path.join(cwd, attempt.manifest), "utf8"));
    const change = record.changeArtifact.changes[0];

    expect(record.changeArtifact.schemaVersion).toBe(2);
    expect(change).toMatchObject({
      changeId: expect.stringMatching(/^[0-9a-f]{20}$/),
      path: "large.txt",
      new: { objectId: expect.stringMatching(/^[0-9a-f]+$/), size: expect.any(Number) },
      diff: { status: "text", sha256: expect.stringMatching(/^[0-9a-f]{64}$/), artifact: expect.stringContaining("changes/files/") }
    });

    const listed = await listReviewResults(cwd);
    expect(listed.results).toContainEqual(expect.objectContaining({ runId: attempt.runId, final: true, resultState: "unapplied", changedFiles: 1 }));
    const summary = await loadResultSummary(cwd, attempt.runId);
    expect(summary.changes[0]!.changeId).toBe(change.changeId);

    const first = await loadFileDiff(cwd, attempt.runId, change.changeId);
    expect(first).toMatchObject({ status: "ready", cursor: "start", truncated: true });
    expect(first.totalBytes).toBeGreaterThan(128 * 1024);
    expect(first.lines.length).toBeLessThanOrEqual(400);
    expect(first.nextCursor).toBeTruthy();
    expect(first.nextCursor).not.toMatch(/^\d+$/);
    const second = await loadFileDiff(cwd, attempt.runId, change.changeId, first.nextCursor);
    expect(second.previousCursor).toBe("start");
    expect(second.lines.length).toBeLessThanOrEqual(400);

    const preview = await previewPatchExport(cwd, attempt.runId);
    expect(preview).toMatchObject({ exists: false, includedFiles: ["large.txt"], excludedSensitiveFiles: [] });
    const exported = await exportPatch(cwd, attempt.runId, preview.destination);
    expect(await access(path.join(cwd, exported.path)).then(() => true)).toBe(true);
    await expect(exportPatch(cwd, attempt.runId, preview.destination)).rejects.toMatchObject({ code: "PATCH_EXPORT_EXISTS" });
    const interruptedPreview = await previewPatchExport(cwd, attempt.runId);
    const controller = new AbortController();
    controller.abort();
    await expect(exportPatch(cwd, attempt.runId, interruptedPreview.destination, false, { signal: controller.signal })).rejects.toThrow("interrupted");
    expect((await loadManagementActions(cwd)).flatMap((item) => item.record ?? [])).toContainEqual(expect.objectContaining({ kind: "patch-export", status: "succeeded", runId: attempt.runId }));
    expect((await loadManagementActions(cwd)).flatMap((item) => item.record ?? [])).toContainEqual(expect.objectContaining({ kind: "patch-export", status: "interrupted", runId: attempt.runId }));
  });

  it("keeps binary content metadata-only and excludes sensitive content from review artifacts", async () => {
    const cwd = await fixture({
      agent: `import { writeFile } from "node:fs/promises"; await writeFile("image.bin", Buffer.from([0,1,2,3,255])); await writeFile(".env", "SECRET=value\\n"); await writeFile("safe.txt", "safe\\n");`
    });
    const batch = await runWorkflow({ cwd });
    const attempt = batch.tasks[0]!.attempts[0]!;
    const record = JSON.parse(await readFile(path.join(cwd, attempt.manifest), "utf8"));
    const summary = await loadResultSummary(cwd, attempt.runId);
    const binary = summary.changes.find((change) => change.path === "image.bin")!;

    expect(binary.diff).toMatchObject({ status: "binary" });
    expect(binary.diff?.artifact).toBeUndefined();
    const page = await loadFileDiff(cwd, attempt.runId, binary.changeId!);
    expect(page).toMatchObject({ status: "binary", lines: [], message: "Binary content is metadata-only." });
    expect(summary.omittedSensitive).toContainEqual(expect.objectContaining({ path: ".env" }));
    const manifest = await readFile(path.join(cwd, record.changeArtifact.manifestArtifact), "utf8");
    expect(manifest).not.toContain("SECRET=value");
  });

  it("records rename, copy, deletion, symlink, and mode metadata without following links", async () => {
    const cwd = await fixture({
      agent: `import { chmod, copyFile, rename, rm, symlink } from "node:fs/promises"; await rename("old-name.txt", "new-name.txt"); await copyFile("copy-source.txt", "copy-target.txt"); await rm("delete-me.txt"); await chmod("script.sh", 0o755); await symlink("copy-source.txt", "source-link");`
    });
    await writeFile(path.join(cwd, "old-name.txt"), "rename content\n");
    await writeFile(path.join(cwd, "copy-source.txt"), "copy content\n");
    await writeFile(path.join(cwd, "delete-me.txt"), "delete content\n");
    await writeFile(path.join(cwd, "script.sh"), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(cwd, "script.sh"), 0o644);
    await execa("git", ["add", "."], { cwd });
    await execa("git", ["-c", "user.name=Ariadne Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "special files"], { cwd });

    const batch = await runWorkflow({ cwd });
    const summary = await loadResultSummary(cwd, batch.tasks[0]!.attempts[0]!.runId);
    expect(summary.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "new-name.txt", originalPath: "old-name.txt", changeType: "renamed", similarity: 100 }),
      expect.objectContaining({ path: "copy-target.txt", originalPath: "copy-source.txt", changeType: "copied", similarity: 100 }),
      expect.objectContaining({ path: "delete-me.txt", changeType: "deleted", old: expect.objectContaining({ objectId: expect.any(String) }) }),
      ...(process.platform === "win32" ? [] : [expect.objectContaining({ path: "script.sh", changeType: "mode-changed", old: expect.objectContaining({ mode: "100644" }), new: expect.objectContaining({ mode: "100755" }) })]),
      expect.objectContaining({ path: "source-link", new: expect.objectContaining({ kind: "symlink", symlinkTarget: "copy-source.txt" }) })
    ]));
  });

  it("makes discard idempotent and normalizes v1 promotion records on read", async () => {
    const cwd = await fixture({ agent: `import { appendFile } from "node:fs/promises"; await appendFile("target.txt", "result\\n");`, retention: "always" });
    const batch = await runWorkflow({ cwd });
    const attempt = batch.tasks[0]!.attempts[0]!;
    const first = await discardResult(cwd, attempt.runId);
    const second = await discardResult(cwd, attempt.runId);
    expect(second.promotionId).toBe(first.promotionId);
    expect(second.status).toBe("discarded");

    const eventPath = path.join(cwd, ".ariadne", "promotions", `${first.promotionId}.json`);
    const legacy = JSON.parse(await readFile(eventPath, "utf8"));
    legacy.schemaVersion = 1;
    delete legacy.discard;
    delete legacy.conflicts;
    delete legacy.failure;
    await writeFile(eventPath, `${JSON.stringify(legacy, null, 2)}\n`);
    const loaded = (await loadPromotions(cwd)).find((item) => item.record?.promotionId === first.promotionId)?.record;
    expect(loaded?.schemaVersion).toBe(2);
  });

  it("rejects dirty and stale targets before apply execution", async () => {
    const cwd = await fixture({ agent: `import { appendFile } from "node:fs/promises"; await appendFile("target.txt", "result\\n");` });
    const batch = await runWorkflow({ cwd });
    const runId = batch.tasks[0]!.attempts[0]!.runId;
    const original = await inspectApplyEligibility(cwd, runId);
    expect(original).toMatchObject({ eligible: true, fingerprint: expect.any(String) });

    await writeFile(path.join(cwd, "dirty.txt"), "dirty\n");
    const dirty = await inspectApplyEligibility(cwd, runId);
    expect(dirty.checks).toContainEqual(expect.objectContaining({ id: "clean", status: "fail" }));
    await execa("git", ["add", "dirty.txt"], { cwd });
    await execa("git", ["-c", "user.name=Ariadne Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "advance target"], { cwd });

    await expect(applyReviewedResult(cwd, runId, original.fingerprint!)).rejects.toMatchObject({ code: "PROMOTION_PREVIEW_STALE" });
    expect(await readFile(path.join(cwd, "target.txt"), "utf8")).toBe("before\n");
  });

  it("keeps cleanup previews read-only and records verified workspace cleanup", async () => {
    const cwd = await fixture({ agent: `import { appendFile } from "node:fs/promises"; await appendFile("target.txt", "result\\n");`, retention: "always" });
    await runWorkflow({ cwd });
    const workspace = (await listManagedWorkspaces(cwd)).workspaces[0]!;
    const beforeActions = await loadManagementActions(cwd);
    const preview = await previewWorkspaceCleanup(cwd, workspace.workspaceId);
    expect(preview).toMatchObject({ eligible: true, missingDirectory: false });
    expect(await loadManagementActions(cwd)).toHaveLength(beforeActions.length);

    const controller = new AbortController();
    controller.abort();
    const interrupted = await cleanWorkspace(cwd, workspace.workspaceId, { signal: controller.signal });
    expect(interrupted).toMatchObject({ action: { status: "interrupted" }, cleaned: [], failed: [] });
    expect((await listManagedWorkspaces(cwd)).workspaces[0]).toMatchObject({ state: "retained", physicalState: "present" });

    const result = await cleanWorkspace(cwd, workspace.workspaceId);
    expect(result).toMatchObject({ action: { kind: "workspace-cleanup", status: "succeeded" }, skipped: [], failed: [] });
    expect(result.cleaned[0]).toMatchObject({ workspaceId: workspace.workspaceId, state: "removed", physicalState: "missing" });
  });

  it("allows only the final retry attempt to pass promotion eligibility", async () => {
    const marker = path.join(await tempDir("ariadne-review-marker-"), "failed-once");
    const cwd = await fixture({
      retry: 2,
      agent: `import { access, writeFile } from "node:fs/promises"; const marker = ${JSON.stringify(marker)}; const exists = await access(marker).then(() => true, () => false); if (!exists) { await writeFile(marker, "1"); process.exit(7); } await writeFile("retry-result.txt", "passed\\n");`
    });
    const batch = await runWorkflow({ cwd });
    const attempts = batch.tasks[0]!.attempts;
    expect(attempts).toHaveLength(2);
    const earlier = await inspectApplyEligibility(cwd, attempts[0]!.runId);
    const final = await inspectApplyEligibility(cwd, attempts[1]!.runId);
    expect(earlier.checks).toContainEqual(expect.objectContaining({ id: "final-attempt", status: "fail" }));
    expect(final.checks).toContainEqual(expect.objectContaining({ id: "final-attempt", status: "pass" }));
    expect(final.eligible).toBe(true);
    const comparison = await compareAttemptResults(cwd, attempts[0]!.runId, attempts[1]!.runId);
    expect(comparison).toMatchObject({
      left: { runId: attempts[0]!.runId, final: false },
      right: { runId: attempts[1]!.runId, final: true },
      addedPaths: ["retry-result.txt"], removedPaths: []
    });
  });
});
