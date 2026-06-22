import path from "node:path";
import fs from "fs-extra";
import { isMap, isScalar, parseDocument } from "yaml";
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

function relativeTaskPath(cwd: string, filePath: string): string {
  return path.relative(cwd, filePath).split(path.sep).join("/");
}

function idValuesFromDocument(rawTask: unknown): string[] {
  if (!isMap(rawTask)) {
    return [];
  }

  const ids: string[] = [];
  for (const item of rawTask.items) {
    if (!isScalar(item.key) || item.key.value !== "id" || !isScalar(item.value)) {
      continue;
    }

    const value = item.value.value;
    if (typeof value === "string" && value.length > 0) {
      ids.push(value);
    }
  }

  return ids;
}

function duplicateTaskIdError(id: string, files: string[]): Error {
  return new Error([
    `[ERROR] Duplicate task id "${id}"`,
    "Found in:",
    ...files.map((file) => `- ${file}`)
  ].join("\n"));
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

  const taskRecords = await Promise.all(files.map(async (filePath) => {
    let source = "";
    let idOccurrences: string[] = [];

    try {
      source = await fs.readFile(filePath, "utf8");
      const document = parseDocument(source, { uniqueKeys: false });
      const message = document.errors[0]?.message;
      if (message) {
        throw new Error(message);
      }

      idOccurrences = idValuesFromDocument(document.contents);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not parse task ${filePath}: ${message}`);
    }

    const fallbackId = path.basename(filePath, path.extname(filePath));
    const ids = idOccurrences.length > 0 ? idOccurrences : [fallbackId];
    return { filePath, source, ids };
  }));

  const taskFilesById = new Map<string, string[]>();
  for (const record of taskRecords) {
    for (const id of record.ids) {
      const taskFiles = taskFilesById.get(id) ?? [];
      taskFiles.push(relativeTaskPath(cwd, record.filePath));
      taskFilesById.set(id, taskFiles);
    }
  }

  for (const [id, taskFiles] of taskFilesById) {
    if (taskFiles.length > 1) {
      throw duplicateTaskIdError(id, taskFiles);
    }
  }

  return taskRecords.map(({ filePath, source }) => {
    const document = parseDocument(source);
    const message = document.errors[0]?.message;
    if (message) {
      throw new Error(`Could not parse task ${filePath}: ${message}`);
    }

    const rawTask = document.toJSON();
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
  });
}
