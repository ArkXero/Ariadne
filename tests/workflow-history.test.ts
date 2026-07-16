import { afterEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { buildBatchHtmlReport, buildBatchReportModel } from "../src/core/workflow-report.js";
import { loadBatchFile, loadBatchHistory, resolveBatchFile } from "../src/core/batch-reader.js";
import { formatBatchCsv, formatBatchMarkdown, listBatches } from "../src/core/batches.js";
import { runWorkflow } from "../src/core/workflow-runner.js";
import { createBatchPaths } from "../src/core/batch-persistence.js";
import { cleanupTempDirs, tempDir, writeProject } from "./helpers.js";

afterEach(cleanupTempDirs);

describe("workflow history and reports", () => {
  it("maintains valid task, batch, and invocation latest pointers", async () => {
    const cwd = await tempDir();
    await writeProject(cwd);
    const first = await runWorkflow({ cwd });
    const second = await runWorkflow({ cwd });
    expect(first.batchId).not.toBe(second.batchId);
    expect(second).toMatchObject({ kind: "batch", runId: second.batchId, batchStatus: "succeeded", status: "completed", outcome: "passed" });
    expect(second.lifecycle.some((event) => event.taskId === "example" && event.detail?.includes("Attempt 1 started"))).toBe(true);
    expect(JSON.parse(await readFile(path.join(cwd, ".ariadne", "batches", "latest.json"), "utf8"))).toMatchObject({ kind: "batch", batchId: second.batchId, manifest: `${second.batchId}/batch.json` });
    expect(JSON.parse(await readFile(path.join(cwd, ".ariadne", "latest.json"), "utf8"))).toMatchObject({ kind: "batch", batchId: second.batchId, manifest: `.ariadne/batches/${second.batchId}/batch.json` });
    expect(await resolveBatchFile(cwd)).toBe(second.outputPath);
    expect((await listBatches(cwd)).batches.map((batch) => batch.batchId)).toEqual([second.batchId, first.batchId]);
  });

  it("continues past corrupt and future batch records", async () => {
    const cwd = await tempDir();
    await writeProject(cwd);
    await runWorkflow({ cwd });
    const batches = path.join(cwd, ".ariadne", "batches");
    await mkdir(path.join(batches, "broken"));
    await writeFile(path.join(batches, "broken", "batch.json"), "{broken");
    await mkdir(path.join(batches, "future"));
    await writeFile(path.join(batches, "future", "batch.json"), JSON.stringify({ schemaVersion: 999 }));
    const history = await loadBatchHistory(cwd);
    expect(history.records.filter((record) => record.ok)).toHaveLength(1);
    expect(history.warnings.join(" ")).toMatch(/broken|newer than supported/);
  });

  it("derives abandoned state for a dead same-host batch owner without rewriting history", async () => {
    const cwd = await tempDir();
    await writeProject(cwd);
    const batch = await runWorkflow({ cwd });
    const raw = JSON.parse(await readFile(batch.outputPath, "utf8"));
    raw.status = "running";
    raw.batchStatus = "running";
    raw.summary.status = "running";
    raw.owner = { ...raw.owner, hostname: os.hostname(), pid: 2_000_000_000 };
    await writeFile(batch.outputPath, JSON.stringify(raw));
    const loaded = await loadBatchFile(batch.outputPath, cwd);
    expect(loaded.ok && loaded.batch).toMatchObject({ status: "abandoned", batchStatus: "abandoned", outcome: "internal_failed" });
    expect(JSON.parse(await readFile(batch.outputPath, "utf8")).status).toBe("running");
  });

  it("warns about missing child records without breaking the batch", async () => {
    const cwd = await tempDir();
    await writeProject(cwd);
    const batch = await runWorkflow({ cwd });
    await rm(path.join(cwd, batch.tasks[0].attempts[0].manifest));
    const loaded = await loadBatchFile(batch.outputPath);
    expect(loaded.ok).toBe(true);
    expect(loaded.ok && loaded.warnings.join(" ")).toContain("missing child run");
  });

  it("rejects batch traversal and warns about child references outside the root", async () => {
    const cwd = await tempDir();
    await writeProject(cwd);
    await expect(resolveBatchFile(cwd, "../outside.json")).rejects.toThrow("inside the project root");
    const batch = await runWorkflow({ cwd });
    const raw = JSON.parse(await readFile(batch.outputPath, "utf8"));
    raw.tasks[0].attempts[0].manifest = "../outside-run.json";
    await writeFile(batch.outputPath, JSON.stringify(raw));
    const loaded = await loadBatchFile(batch.outputPath, cwd);
    expect(loaded.ok && loaded.warnings.join(" ")).toContain("outside the project root");
  });

  it("escapes hostile batch HTML and keeps export values safe", async () => {
    const cwd = await tempDir();
    await writeProject(cwd, { tasks: [{ id: "safe" }] });
    await writeFile(path.join(cwd, ".ariadne", "tasks", "safe.yml"), `id: safe\nname: '=2+3 | <script>alert(1)</script>'\nprompt: safe\n`);
    const batch = await runWorkflow({ cwd });
    const html = buildBatchHtmlReport(buildBatchReportModel(batch));
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    const listed = await listBatches(cwd);
    expect(formatBatchCsv(listed.batches)).toContain("succeeded");
    expect(formatBatchMarkdown(listed.batches)).toContain("batch_id");
  });

  it("persists partial running state before interruption", async () => {
    const cwd = await tempDir();
    await writeProject(cwd, { agentArgs: ["-e", "require('fs').writeFileSync('started', 'yes'); setInterval(() => {}, 1000)"] });
    const controller = new AbortController();
    const pending = runWorkflow({ cwd, signal: controller.signal });
    for (let index = 0; index < 200; index += 1) {
      if (await readFile(path.join(cwd, "started"), "utf8").catch(() => undefined)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const history = await loadBatchHistory(cwd);
    expect(history.records.some((record) => record.ok && record.batch.status === "running" && record.batch.batchStatus === "running" && record.batch.summary.total === 1 && record.batch.tasks[0]?.state === "running")).toBe(true);
    controller.abort("test");
    expect((await pending).batchStatus).toBe("interrupted");
  });

  it("refuses batch-directory collisions", async () => {
    const cwd = await tempDir();
    await createBatchPaths(cwd, "same");
    await expect(createBatchPaths(cwd, "same")).rejects.toThrow("already exists");
  });

  it("persists incomplete state and valid pointers after a report finalization failure", async () => {
    const cwd = await tempDir();
    await writeProject(cwd, { agentArgs: ["-e", "const fs=require('node:fs'); (async()=>{fs.writeFileSync('started','yes'); while(!fs.existsSync('release')) await new Promise(r=>setTimeout(r,5));})()"] });
    const pending = runWorkflow({ cwd });
    for (let index = 0; index < 200; index += 1) {
      if (await readFile(path.join(cwd, "started"), "utf8").catch(() => undefined)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const batchId = (await readdir(path.join(cwd, ".ariadne", "batches"))).find((entry) => entry !== "latest.json")!;
    await mkdir(path.join(cwd, ".ariadne", "batches", batchId, "report.html"));
    await writeFile(path.join(cwd, "release"), "yes");
    const batch = await pending;
    expect(batch).toMatchObject({ status: "incomplete", batchStatus: "incomplete", outcome: "internal_failed" });
    expect(batch.failures.some((item) => item.code === "BATCH_FINALIZATION_FAILED")).toBe(true);
    expect(JSON.parse(await readFile(path.join(cwd, ".ariadne", "batches", "latest.json"), "utf8"))).toMatchObject({ batchId, status: "incomplete", batchStatus: "incomplete" });
  });
});
