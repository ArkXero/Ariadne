import type { AriadneTask } from "../types/index.js";

export interface DuplicateTaskId {
  id: string;
  files: string[];
}

export function findDuplicateTaskIds(tasks: Array<Pick<AriadneTask, "id" | "file">>): DuplicateTaskId[] {
  const filesById = new Map<string, string[]>();

  for (const task of tasks) {
    const files = filesById.get(task.id) ?? [];
    files.push(task.file);
    filesById.set(task.id, files);
  }

  return [...filesById.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([id, files]) => ({
      id,
      files: files.slice().sort()
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function formatDuplicateTaskIds(duplicates: DuplicateTaskId[]): string {
  const lines = duplicates.flatMap((duplicate) => [
    `Duplicate task id "${duplicate.id}" found in:`,
    ...duplicate.files.map((file) => `  - ${file}`)
  ]);

  return lines.join("\n");
}

export function assertUniqueTaskIds(tasks: Array<Pick<AriadneTask, "id" | "file">>): void {
  const duplicates = findDuplicateTaskIds(tasks);
  if (duplicates.length > 0) {
    throw new Error(formatDuplicateTaskIds(duplicates));
  }
}
