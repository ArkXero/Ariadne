import path from "node:path";
import fs from "fs-extra";
import { parse } from "yaml";
import { z } from "zod";
import type { AriadneTask } from "../types/index.js";

const TaskSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  prompt: z.string().min(1, "prompt is required"),
  metadata: z.record(z.string(), z.unknown()).optional()
});

async function collectYamlFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      return collectYamlFiles(entryPath);
    }

    if (entry.isFile() && /\.(ya?ml)$/i.test(entry.name)) {
      return [entryPath];
    }

    return [];
  }));

  return files.flat().sort();
}

export async function loadTasks(cwd: string, tasksDirectory: string): Promise<AriadneTask[]> {
  const resolvedDirectory = path.resolve(cwd, tasksDirectory);

  if (!(await fs.pathExists(resolvedDirectory))) {
    throw new Error(`Tasks directory not found: ${resolvedDirectory}. Run "ariadne init" first.`);
  }

  const files = await collectYamlFiles(resolvedDirectory);
  if (files.length === 0) {
    throw new Error(`No task YAML files found in ${resolvedDirectory}.`);
  }

  return Promise.all(files.map(async (filePath) => {
    let rawTask: unknown;
    try {
      rawTask = parse(await fs.readFile(filePath, "utf8"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not parse task ${filePath}: ${message}`);
    }

    const parsed = TaskSchema.safeParse(rawTask ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n");
      throw new Error(`Invalid task ${filePath}:\n${issues}`);
    }

    const id = parsed.data.id ?? path.basename(filePath, path.extname(filePath));
    return {
      ...parsed.data,
      id,
      name: parsed.data.name ?? id,
      file: filePath
    };
  }));
}
