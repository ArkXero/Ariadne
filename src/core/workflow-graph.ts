import { AriadneError } from "./errors.js";
import type { AriadneTask } from "../types/index.js";

function compareIds(left: string, right: string): number {
  const lowerLeft = left.toLowerCase();
  const lowerRight = right.toLowerCase();
  return lowerLeft < lowerRight ? -1 : lowerLeft > lowerRight ? 1 : left < right ? -1 : left > right ? 1 : 0;
}

function immutableCopy<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map((item) => immutableCopy(item))) as T;
  if (value && typeof value === "object") {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, immutableCopy(child)]))) as T;
  }
  return value;
}

export class WorkflowGraph {
  readonly tasks: readonly AriadneTask[];
  private readonly byKey: Map<string, AriadneTask>;
  private readonly dependencies: Map<string, readonly string[]>;
  private readonly dependents: Map<string, readonly string[]>;

  constructor(input: readonly AriadneTask[]) {
    const tasks = [...input].sort((left, right) => compareIds(left.id, right.id)).map((task) => Object.freeze({
      ...task,
      metadata: immutableCopy(task.metadata ?? {}),
      dependsOn: Object.freeze([...task.dependsOn]) as unknown as string[],
      retry: Object.freeze({ ...task.retry }),
      ...(task.verify ? { verify: Object.freeze(task.verify.map((spec) => spec.kind === "exec" ? Object.freeze({ ...spec, args: Object.freeze([...spec.args]) as unknown as string[] }) : Object.freeze({ ...spec }))) as unknown as AriadneTask["verify"] } : {})
    }));
    const duplicate = tasks.find((task, index) => tasks.findIndex((candidate) => candidate.id.toLowerCase() === task.id.toLowerCase()) !== index);
    if (duplicate) {
      const conflicts = tasks.filter((task) => task.id.toLowerCase() === duplicate.id.toLowerCase());
      throw new AriadneError({
        category: "task_loading", code: "TASK_ID_DUPLICATE", stage: "validated", fieldPath: "id", offendingValue: duplicate.id,
        message: `Duplicate task id "${duplicate.id}" in ${conflicts.map((task) => task.file).join(", ")}.`,
        correction: "Give every task a unique ID; IDs are compared case-insensitively.",
        details: { files: conflicts.map((task) => task.file) }
      });
    }
    const byKey = new Map(tasks.map((task) => [task.id.toLowerCase(), task]));
    const dependencies = new Map<string, readonly string[]>();
    const mutableDependents = new Map(tasks.map((task) => [task.id, [] as string[]]));

    for (const task of tasks) {
      const seen = new Set<string>();
      const canonical: string[] = [];
      for (const requested of task.dependsOn) {
        const key = requested.toLowerCase();
        if (seen.has(key)) {
          throw new AriadneError({
            category: "task_loading", code: "TASK_DEPENDENCY_DUPLICATE", stage: "validated", source: task.file,
            fieldPath: "dependsOn", offendingValue: requested,
            message: `Task "${task.id}" lists dependency "${requested}" more than once.`,
            correction: "Remove duplicate dependency entries; dependency IDs are compared case-insensitively."
          });
        }
        seen.add(key);
        if (key === task.id.toLowerCase()) {
          throw new AriadneError({
            category: "task_loading", code: "TASK_DEPENDENCY_SELF", stage: "validated", source: task.file,
            fieldPath: "dependsOn", offendingValue: requested,
            message: `Task "${task.id}" cannot depend on itself.`, correction: "Remove the self-dependency."
          });
        }
        const dependency = byKey.get(key);
        if (!dependency) {
          throw new AriadneError({
            category: "task_loading", code: "TASK_DEPENDENCY_NOT_FOUND", stage: "validated", source: task.file,
            fieldPath: "dependsOn", offendingValue: requested,
            message: `Task "${task.id}" depends on unknown task "${requested}".`,
            correction: `Choose one of: ${tasks.map((candidate) => candidate.id).join(", ")}.`
          });
        }
        canonical.push(dependency.id);
        mutableDependents.get(dependency.id)!.push(task.id);
      }
      dependencies.set(task.id, Object.freeze(canonical.sort(compareIds)));
    }

    this.tasks = Object.freeze(tasks);
    this.byKey = byKey;
    this.dependencies = dependencies;
    this.dependents = new Map([...mutableDependents].map(([id, values]) => [id, Object.freeze(values.sort(compareIds))]));
    this.assertAcyclic();
    Object.freeze(this);
  }

  get(id: string): AriadneTask | undefined {
    return this.byKey.get(id.toLowerCase());
  }

  require(id: string): AriadneTask {
    const task = this.get(id);
    if (task) return task;
    throw new AriadneError({
      category: "task_selection", code: "TASK_NOT_FOUND", stage: "validated", offendingValue: id,
      message: `Task selection did not match: ${id}.`,
      correction: `Choose one of: ${this.tasks.map((candidate) => candidate.id).join(", ")}.`,
      details: { requested: id, available: this.tasks.map((candidate) => candidate.id) }
    });
  }

  dependencyIds(id: string): readonly string[] {
    return this.dependencies.get(this.require(id).id) ?? [];
  }

  dependentIds(id: string): readonly string[] {
    return this.dependents.get(this.require(id).id) ?? [];
  }

  closure(rootIds: readonly string[]): string[] {
    const roots = rootIds.length === 0 ? this.tasks.map((task) => task.id) : rootIds.map((id) => this.require(id).id);
    const included = new Set<string>();
    const visit = (id: string): void => {
      if (included.has(id)) return;
      included.add(id);
      for (const dependency of this.dependencyIds(id)) visit(dependency);
    };
    for (const id of roots) visit(id);
    return [...included].sort(compareIds);
  }

  topological(includedIds: readonly string[] = this.tasks.map((task) => task.id)): { order: string[]; levels: string[][] } {
    const included = new Set(includedIds.map((id) => this.require(id).id));
    const remaining = new Map<string, number>();
    const levels = new Map<string, number>();
    for (const id of included) remaining.set(id, this.dependencyIds(id).filter((dependency) => included.has(dependency)).length);
    const ready = [...remaining].filter(([, count]) => count === 0).map(([id]) => id).sort(compareIds);
    const order: string[] = [];
    while (ready.length > 0) {
      const id = ready.shift()!;
      order.push(id);
      const dependencies = this.dependencyIds(id).filter((dependency) => included.has(dependency));
      levels.set(id, dependencies.length === 0 ? 0 : Math.max(...dependencies.map((dependency) => levels.get(dependency) ?? 0)) + 1);
      for (const dependent of this.dependentIds(id).filter((candidate) => included.has(candidate))) {
        const next = (remaining.get(dependent) ?? 0) - 1;
        remaining.set(dependent, next);
        if (next === 0) {
          ready.push(dependent);
          ready.sort(compareIds);
        }
      }
    }
    const grouped: string[][] = [];
    for (const id of order) (grouped[levels.get(id) ?? 0] ??= []).push(id);
    return { order, levels: grouped.map((group) => group.sort(compareIds)) };
  }

  private assertAcyclic(): void {
    const state = new Map<string, "visiting" | "visited">();
    const stack: string[] = [];
    const visit = (id: string): void => {
      const current = state.get(id);
      if (current === "visited") return;
      if (current === "visiting") {
        const index = stack.indexOf(id);
        const cycle = [...stack.slice(index), id];
        throw new AriadneError({
          category: "task_loading", code: "TASK_DEPENDENCY_CYCLE", stage: "validated",
          message: `Task dependency cycle detected: ${cycle.join(" -> ")}.`,
          correction: "Remove at least one dependency edge from the cycle.", details: { cycle }
        });
      }
      state.set(id, "visiting");
      stack.push(id);
      for (const dependency of this.dependencies.get(id) ?? []) visit(dependency);
      stack.pop();
      state.set(id, "visited");
    };
    for (const task of this.tasks) visit(task.id);
  }
}
