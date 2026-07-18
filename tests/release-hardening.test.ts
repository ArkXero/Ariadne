import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { DEFAULT_IO_CONCURRENCY, mapWithConcurrency } from "../src/core/bounded-map.js";
import { loadRunHistory } from "../src/core/run-reader.js";
import { cleanupTempDirs, tempDir } from "./helpers.js";

afterEach(cleanupTempDirs);

describe("release resource boundaries", () => {
  it("preserves input order while bounding asynchronous filesystem work", async () => {
    let active = 0;
    let maximum = 0;
    const values = Array.from({ length: 200 }, (_, index) => index);
    const result = await mapWithConcurrency(values, 7, async (value) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      return value * 2;
    });
    expect(maximum).toBeLessThanOrEqual(7);
    expect(result).toEqual(values.map((value) => value * 2));
  });

  it("loads 1,000 valid and corrupt history records without unbounded fan-out", async () => {
    const cwd = await tempDir("ariadne-history-scale-");
    const runs = path.join(cwd, ".ariadne", "runs");
    await mkdir(runs, { recursive: true });
    const indexes = Array.from({ length: 1_000 }, (_, index) => index);
    await mapWithConcurrency(indexes, DEFAULT_IO_CONCURRENCY, (index) => writeFile(
      path.join(runs, `run-${String(index).padStart(4, "0")}.json`),
      index % 100 === 0 ? "{broken" : `${JSON.stringify({ version: 1, startedAt: new Date(1_700_000_000_000 + index).toISOString(), results: [] })}\n`
    ));
    const history = await loadRunHistory(cwd);
    expect(history.records).toHaveLength(1_000);
    expect(history.records.filter((record) => record.ok)).toHaveLength(990);
    expect(history.warnings.filter((warning) => warning.includes("Could not parse"))).toHaveLength(10);
  });
});
