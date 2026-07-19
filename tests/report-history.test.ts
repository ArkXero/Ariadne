import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { buildHtmlReport, buildReportModel, findLatestRunFile, loadRunReport } from "../src/core/report.js";
import { loadRunFile, loadRunHistory } from "../src/core/run-reader.js";
import { formatRunCsv, formatRunMarkdown, listRuns } from "../src/core/runs.js";
import { runAriadne } from "../src/core/runner.js";
import { cleanupTempDirs, tempDir, writeProject } from "./helpers.js";

afterEach(cleanupTempDirs);

describe("canonical reports", () => {
  it("escapes hostile content in offline HTML", async () => {
    const cwd = await tempDir();
    await writeProject(cwd, { tasks: [{ id: "safe" }] });
    const run = await runAriadne({ cwd });
    const model = buildReportModel(run);
    model.tasks[0].name = '<script>alert("x")</script><img src=x onerror=alert(1)>';
    model.tasks[0].failures = ["</textarea><script>bad()</script>"];
    model.warnings = ["Review this warning"];
    const html = buildHtmlReport(model);
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("onerror=alert(1)>");
    expect(html).toContain("@media print");
    expect(html).toContain("#F6453C");
    expect(html).toContain("#F59E0B");
    expect(html).toContain("#FCF7F8");
    expect(html).toContain("#CED3DC");
    expect(html).toContain('class="card warning"');
    expect(html).not.toContain("#f6f7f4");
    expect(html).toContain("Run lifecycle");
    expect(html).toContain("Task-attributed changes");
    expect(html).toContain("score breakdown");
  });

  it("normalizes legacy v1 records without rewriting them", async () => {
    const cwd = await tempDir();
    const runs = path.join(cwd, ".ariadne", "runs");
    await mkdir(runs, { recursive: true });
    const legacyPath = path.join(runs, "legacy.json");
    const legacy = {
      version: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
      durationMs: 1000,
      results: [{
        task: { id: "old", name: "Old", file: "task.yml", prompt: "secret" },
        agent: { command: "cat", exitCode: 0, stdout: "", stderr: "", runtimeMs: 1, startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:00.001Z", timedOut: false },
        verification: [],
        trace: { changedFiles: ["old.txt"], diffLineCount: 1 },
        score: { passed: true, status: "passed", checks: [] }
      }]
    };
    await writeFile(legacyPath, JSON.stringify(legacy));
    const before = await readFile(legacyPath, "utf8");
    const model = await loadRunReport(legacyPath);
    expect(model).toMatchObject({ schemaVersion: 1, status: "completed", warnings: [expect.stringContaining("Legacy")] });
    expect(model.tasks[0].changedFiles).toEqual(["old.txt"]);
    expect(await readFile(legacyPath, "utf8")).toBe(before);
  });

  it("loads historical v2 records through the compatibility reader", async () => {
    const cwd = await tempDir();
    await writeProject(cwd);
    const run = await runAriadne({ cwd });
    const raw = JSON.parse(await readFile(run.outputPath, "utf8"));
    raw.schemaVersion = 2;
    delete raw.workflow;
    await writeFile(run.outputPath, JSON.stringify(raw));
    const loaded = await loadRunFile(run.outputPath);
    expect(loaded.ok && loaded.run.schemaVersion).toBe(2);
    expect(loaded.ok && loaded.warnings.join(" ")).toContain("version 2");
  });

  it("loads historical v4 records without inventing benchmark results or rewriting history", async () => {
    const cwd = await tempDir();
    await writeProject(cwd);
    const run = await runAriadne({ cwd });
    const raw = JSON.parse(await readFile(run.outputPath, "utf8"));
    raw.schemaVersion = 4;
    raw.config.version = 4;
    raw.config.execution.isolation = "worktree";
    raw.config.execution.worktree.retention = "always";
    await writeFile(run.outputPath, JSON.stringify(raw));
    const before = await readFile(run.outputPath, "utf8");
    const loaded = await loadRunFile(run.outputPath);
    expect(loaded.ok && loaded.run.schemaVersion).toBe(4);
    expect(loaded.ok && "config" in loaded.run && loaded.run.config?.execution).toMatchObject({ isolation: "worktree", worktree: { retention: "always" } });
    expect(loaded.ok && "results" in loaded.run && loaded.run.results?.[0]).not.toHaveProperty("benchmark");
    expect(loaded.ok && loaded.warnings.join(" ")).toContain("version 4");
    expect(await readFile(run.outputPath, "utf8")).toBe(before);
  });

  it("reports missing artifacts as warnings", async () => {
    const cwd = await tempDir();
    await writeProject(cwd);
    const run = await runAriadne({ cwd });
    await rm(path.join(cwd, run.results[0].agent!.stdoutArtifact));
    expect((await loadRunReport(run.outputPath)).warnings.join(" ")).toContain("missing artifact");
  });
});

describe("history resilience and renderers", () => {
  it("continues past corrupted and future records", async () => {
    const cwd = await tempDir();
    await writeProject(cwd);
    await runAriadne({ cwd });
    const runs = path.join(cwd, ".ariadne", "runs");
    await writeFile(path.join(runs, "broken.json"), "{broken");
    await writeFile(path.join(runs, "future.json"), JSON.stringify({ schemaVersion: 999, startedAt: new Date().toISOString(), results: [] }));
    const history = await loadRunHistory(cwd);
    expect(history.records.filter((record) => record.ok)).toHaveLength(1);
    expect(history.warnings.join(" ")).toMatch(/broken|newer than supported/);
    expect((await listRuns(cwd)).runs).toHaveLength(1);
  });

  it("uses a valid latest pointer and falls back when the pointer is corrupt", async () => {
    const cwd = await tempDir();
    await writeProject(cwd);
    const run = await runAriadne({ cwd });
    expect(await findLatestRunFile(cwd)).toBe(run.outputPath);
    await writeFile(path.join(cwd, ".ariadne", "runs", "latest.json"), "not-json");
    expect(await findLatestRunFile(cwd)).toBe(run.outputPath);
  });

  it("presents dead same-host running records as abandoned without rewriting them", async () => {
    const cwd = await tempDir();
    await writeProject(cwd);
    const run = await runAriadne({ cwd });
    const raw = JSON.parse(await readFile(run.outputPath, "utf8"));
    raw.status = "running";
    raw.summary.status = "running";
    raw.owner.pid = 2_147_483_647;
    await writeFile(run.outputPath, JSON.stringify(raw));
    const before = await readFile(run.outputPath, "utf8");
    const loaded = await loadRunFile(run.outputPath);
    expect(loaded.ok && loaded.run.status).toBe("abandoned");
    expect(loaded.ok && loaded.warnings.join(" ")).toContain("no longer alive");
    expect(await readFile(run.outputPath, "utf8")).toBe(before);
  });

  it("escapes CSV commas, quotes, and newlines and Markdown pipes", () => {
    const entry = [{
      startedAt: "2026-01-01T00:00:00.000Z", started: "2026-01-01 00:00", status: "completed", outcome: "passed",
      taskId: "id", taskName: "Name, \"quoted\" | next\nline <script>alert(1)</script>", durationMs: 1, duration: "1ms", path: "run.json", runId: "run", score: 100, violations: 0
    }];
    expect(formatRunCsv(entry)).toContain('"Name, ""quoted"" | next\nline <script>alert(1)</script>"');
    const markdown = formatRunMarkdown(entry);
    expect(markdown).toContain("\\| next<br>line &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(markdown).not.toContain("<script>");
  });

  it("neutralizes spreadsheet formulas in every CSV text field", () => {
    const entry = [{
      startedAt: "2026-01-01T00:00:00.000Z", started: "2026-01-01 00:00", status: "completed", outcome: "passed",
      taskId: "+SUM(A1:A2)", taskName: "=2+3", durationMs: 1, duration: "1ms", path: "@payload", runId: "-run", score: 100, violations: 0
    }];
    const csv = formatRunCsv(entry);
    expect(csv).toContain("'+SUM(A1:A2)");
    expect(csv).toContain("'=2+3");
    expect(csv).toContain("'@payload");
  });

  it("keeps listed manifest paths repository-relative", async () => {
    const cwd = await tempDir();
    await writeProject(cwd);
    await runAriadne({ cwd });
    expect((await listRuns(cwd)).runs[0].path).toMatch(/^\.ariadne\/runs\//);
  });
});
