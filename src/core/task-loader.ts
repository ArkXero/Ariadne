import path from "node:path";
import fs from "fs-extra";
import { isMap, isScalar, parseDocument } from "yaml";
import { z } from "zod";
import { AriadneError } from "./errors.js";
import type { AriadneTask, LegacyConfigVersion } from "../types/index.js";

export const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const ProcessSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exec"), file: z.string().trim().min(1), args: z.array(z.string()).default([]) }).strict(),
  z.object({ kind: z.literal("shell"), command: z.string().trim().min(1) }).strict()
]);

const BaseTaskSchema = z.object({
  id: z.string().trim().regex(TASK_ID_PATTERN, "id must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}").optional(),
  name: z.string().trim().min(1).optional(),
  prompt: z.string().trim().min(1, "prompt is required"),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const LegacyTaskSchema = BaseTaskSchema.strict();
const V3TaskSchema = BaseTaskSchema.extend({
  dependsOn: z.array(z.string().trim().regex(TASK_ID_PATTERN, "dependency id must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}")).default([]),
  parallelSafe: z.boolean().default(false),
  retry: z.object({
    attempts: z.number().int().min(1).max(10).default(1),
    delayMs: z.number().int().min(0).max(3_600_000).default(0),
    backoff: z.enum(["fixed", "exponential"]).default("fixed")
  }).strict().default({ attempts: 1, delayMs: 0, backoff: "fixed" }),
  verify: z.array(ProcessSpecSchema).optional()
}).strict();
const V4TaskSchema = BaseTaskSchema.extend({
  dependsOn: z.array(z.string().trim().regex(TASK_ID_PATTERN, "dependency id must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}")).default([]),
  workspaceMode: z.enum(["mutable", "read-only"]).default("mutable"),
  retry: z.object({
    attempts: z.number().int().min(1).max(10).default(1),
    delayMs: z.number().int().min(0).max(3_600_000).default(0),
    backoff: z.enum(["fixed", "exponential"]).default("fixed")
  }).strict().default({ attempts: 1, delayMs: 0, backoff: "fixed" }),
  verify: z.array(ProcessSpecSchema).optional()
}).strict();

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeRelative(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

async function collectYamlFiles(root: string, directory: string, visited = new Set<string>()): Promise<string[]> {
  const canonicalDirectory = await fs.realpath(directory);
  if (visited.has(canonicalDirectory)) return [];
  visited.add(canonicalDirectory);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const resolved = await fs.realpath(entryPath);
      if (!isInside(root, resolved)) {
        throw new AriadneError({
          category: "task_loading",
          code: "TASK_PATH_OUTSIDE_ROOT",
          stage: "loading",
          source: entryPath,
          message: "Task path symlink resolves outside the project root.",
          correction: "Remove the symlink or point it to a task inside the project root."
        });
      }
      const target = await fs.stat(resolved);
      if (target.isDirectory()) files.push(...await collectYamlFiles(root, resolved, visited));
      else if (target.isFile() && /\.(ya?ml)$/i.test(entry.name)) files.push(resolved);
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...await collectYamlFiles(root, entryPath, visited));
    } else if (entry.isFile() && /\.(ya?ml)$/i.test(entry.name)) {
      const resolved = await fs.realpath(entryPath);
      if (!isInside(root, resolved)) {
        throw new AriadneError({
          category: "task_loading",
          code: "TASK_PATH_OUTSIDE_ROOT",
          stage: "loading",
          source: entryPath,
          message: "Task file resolves outside the project root.",
          correction: "Move task files into the configured task directory."
        });
      }
      files.push(resolved);
    }
  }

  return files.sort();
}

function idValuesFromDocument(rawTask: unknown): string[] {
  if (!isMap(rawTask)) return [];
  const ids: string[] = [];
  for (const item of rawTask.items) {
    if (!isScalar(item.key) || item.key.value !== "id" || !isScalar(item.value)) continue;
    if (typeof item.value.value === "string") ids.push(item.value.value.trim());
  }
  return ids;
}

function duplicateTaskIdError(id: string, files: string[]): AriadneError {
  return new AriadneError({
    category: "task_loading",
    code: "TASK_ID_DUPLICATE",
    stage: "loading",
    fieldPath: "id",
    offendingValue: id,
    message: [`Duplicate task id "${id}".`, "Found in:", ...files.map((file) => `- ${file}`)].join("\n"),
    correction: "Give every task a unique ID; IDs are compared case-insensitively."
  });
}

export async function loadTasks(
  projectRoot: string,
  tasksDirectory: string,
  contractVersion: LegacyConfigVersion | 4 = 4
): Promise<AriadneTask[]> {
  const canonicalRoot = await fs.realpath(projectRoot).catch(() => path.resolve(projectRoot));
  const unresolvedDirectory = path.resolve(canonicalRoot, tasksDirectory);
  if (!isInside(canonicalRoot, unresolvedDirectory)) {
    throw new AriadneError({
      category: "task_loading",
      code: "TASK_DIRECTORY_OUTSIDE_ROOT",
      stage: "loading",
      source: unresolvedDirectory,
      message: "Tasks directory resolves outside the project root.",
      correction: "Use a repository-relative tasks.directory without traversal."
    });
  }
  if (!(await fs.pathExists(unresolvedDirectory))) {
    throw new AriadneError({
      category: "task_loading",
      code: "TASK_DIRECTORY_NOT_FOUND",
      stage: "loading",
      source: unresolvedDirectory,
      message: `Tasks directory not found: ${tasksDirectory}.`,
      correction: "Run \"ariadne init\" or create the configured tasks directory."
    });
  }

  const resolvedDirectory = await fs.realpath(unresolvedDirectory);
  if (!isInside(canonicalRoot, resolvedDirectory)) {
    throw new AriadneError({
      category: "task_loading",
      code: "TASK_DIRECTORY_SYMLINK_OUTSIDE_ROOT",
      stage: "loading",
      source: unresolvedDirectory,
      message: "Tasks directory symlink resolves outside the project root.",
      correction: "Use a directory inside the project root."
    });
  }

  const files = await collectYamlFiles(canonicalRoot, resolvedDirectory);
  if (files.length === 0) {
    throw new AriadneError({
      category: "task_loading",
      code: "TASKS_EMPTY",
      stage: "loading",
      source: resolvedDirectory,
      message: `No task YAML files found in ${normalizeRelative(canonicalRoot, resolvedDirectory)}.`,
      correction: "Add at least one .yml or .yaml task file."
    });
  }

  const records = await Promise.all(files.map(async (filePath) => {
    const relativeFile = normalizeRelative(canonicalRoot, filePath);
    const source = await fs.readFile(filePath, "utf8");
    const document = parseDocument(source, { uniqueKeys: false });
    if (document.errors.length > 0) {
      throw new AriadneError({
        category: "task_loading",
        code: "TASK_YAML_INVALID",
        stage: "loading",
        source: relativeFile,
        message: `Could not parse task ${relativeFile}: ${document.errors[0].message}`,
        correction: "Fix the YAML syntax and run \"ariadne doctor\" again."
      });
    }

    const fallbackId = path.basename(filePath, path.extname(filePath));
    const explicitIds = idValuesFromDocument(document.contents);
    if (new Set(explicitIds.map((id) => id.toLowerCase())).size > 1) {
      throw new AriadneError({
        category: "task_loading",
        code: "TASK_SCHEMA_INVALID",
        stage: "loading",
        source: relativeFile,
        fieldPath: "id",
        message: `Task ${relativeFile} defines the id field more than once with conflicting values.`,
        correction: "Keep exactly one id field in each task YAML file."
      });
    }
    return {
      filePath,
      relativeFile,
      source,
      ids: explicitIds.length > 0 ? explicitIds : [fallbackId]
    };
  }));

  const definitions = new Map<string, { displayId: string; files: string[] }>();
  for (const record of records) {
    for (const id of record.ids) {
      const key = id.toLowerCase();
      const existing = definitions.get(key) ?? { displayId: id, files: [] };
      existing.files.push(record.relativeFile);
      definitions.set(key, existing);
    }
  }
  for (const value of definitions.values()) {
    if (value.files.length > 1) throw duplicateTaskIdError(value.displayId, value.files);
  }

  return records.map((record) => {
    const document = parseDocument(record.source);
    const rawTask = document.toJSON();
    const schema = contractVersion === 4 ? V4TaskSchema : contractVersion === 3 ? V3TaskSchema : LegacyTaskSchema;
    const parsed = schema.safeParse(rawTask ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.length === 0 ? "(root)" : issue.path.join(".")}: ${issue.message}`);
      throw new AriadneError({
        category: "task_loading",
        code: "TASK_SCHEMA_INVALID",
        stage: "loading",
        source: record.relativeFile,
        message: `Invalid task ${record.relativeFile}:\n${issues.join("\n")}`,
        correction: "Fix the listed fields and run \"ariadne doctor\" again.",
        details: { issues }
      });
    }

    const id = parsed.data.id ?? path.basename(record.filePath, path.extname(record.filePath));
    if (!TASK_ID_PATTERN.test(id)) {
      throw new AriadneError({
        category: "task_loading",
        code: "TASK_ID_INVALID",
        stage: "loading",
        source: record.relativeFile,
        message: `Task id "${id}" is not path-safe.`,
        fieldPath: "id",
        offendingValue: id,
        expected: "[A-Za-z0-9][A-Za-z0-9._-]{0,63}",
        correction: "Set an explicit path-safe task id."
      });
    }

    const orchestration = contractVersion === 4
      ? parsed.data as z.infer<typeof V4TaskSchema>
      : contractVersion === 3
        ? { ...(parsed.data as z.infer<typeof V3TaskSchema>), workspaceMode: (parsed.data as z.infer<typeof V3TaskSchema>).parallelSafe ? "read-only" as const : "mutable" as const }
        : { ...parsed.data, dependsOn: [], workspaceMode: "mutable" as const, retry: { attempts: 1, delayMs: 0, backoff: "fixed" as const } };
    return {
      id,
      name: parsed.data.name ?? id,
      file: record.relativeFile,
      prompt: parsed.data.prompt,
      ...(parsed.data.metadata ? { metadata: parsed.data.metadata } : {}),
      dependsOn: orchestration.dependsOn,
      workspaceMode: orchestration.workspaceMode,
      retry: orchestration.retry,
      ...((contractVersion === 3 || contractVersion === 4) && "verify" in orchestration && orchestration.verify !== undefined ? { verify: orchestration.verify } : {})
    };
  });
}
