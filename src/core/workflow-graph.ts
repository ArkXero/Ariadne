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

class OrderedIds {
  private readonly values: string[] = [];

  get size(): number {
    return this.values.length;
  }

  push(value: string): void {
    this.values.push(value);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareIds(this.values[parent], this.values[index]) <= 0) break;
      [this.values[parent], this.values[index]] = [this.values[index], this.values[parent]];
      index = parent;
    }
  }

  pop(): string | undefined {
    const first = this.values[0];
    const last = this.values.pop();
    if (this.values.length === 0 || last === undefined) return first;
    this.values[0] = last;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < this.values.length && compareIds(this.values[left], this.values[smallest]) < 0) smallest = left;
      if (right < this.values.length && compareIds(this.values[right], this.values[smallest]) < 0) smallest = right;
      if (smallest === index) break;
      [this.values[index], this.values[smallest]] = [this.values[smallest], this.values[index]];
      index = smallest;
    }
    return first;
  }
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
    const tasksByKey = new Map<string, AriadneTask[]>();
    for (const task of tasks) {
      const key = task.id.toLowerCase();
      const matches = tasksByKey.get(key) ?? [];
      matches.push(task);
      tasksByKey.set(key, matches);
    }
    const conflicts = [...tasksByKey.values()].find((matches) => matches.length > 1);
    if (conflicts) {
      const duplicate = conflicts[0];
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
    const pending = [...roots];
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (included.has(id)) continue;
      included.add(id);
      pending.push(...this.dependencyIds(id));
    }
    return [...included].sort(compareIds);
  }

  topological(includedIds: readonly string[] = this.tasks.map((task) => task.id)): { order: string[]; levels: string[][] } {
    const included = new Set(includedIds.map((id) => this.require(id).id));
    const remaining = new Map<string, number>();
    const levels = new Map<string, number>();
    for (const id of included) remaining.set(id, this.dependencyIds(id).filter((dependency) => included.has(dependency)).length);
    const ready = new OrderedIds();
    for (const [id, count] of remaining) if (count === 0) ready.push(id);
    const order: string[] = [];
    while (ready.size > 0) {
      const id = ready.pop()!;
      order.push(id);
      const dependencies = this.dependencyIds(id).filter((dependency) => included.has(dependency));
      levels.set(id, dependencies.length === 0 ? 0 : Math.max(...dependencies.map((dependency) => levels.get(dependency) ?? 0)) + 1);
      for (const dependent of this.dependentIds(id).filter((candidate) => included.has(candidate))) {
        const next = (remaining.get(dependent) ?? 0) - 1;
        remaining.set(dependent, next);
        if (next === 0) ready.push(dependent);
      }
    }
    const grouped: string[][] = [];
    for (const id of order) (grouped[levels.get(id) ?? 0] ??= []).push(id);
    return { order, levels: grouped.map((group) => group.sort(compareIds)) };
  }

  private assertAcyclic(): void {
    const remaining = new Map(this.tasks.map((task) => [task.id, this.dependencies.get(task.id)?.length ?? 0]));
    const ready = new OrderedIds();
    for (const [id, count] of remaining) if (count === 0) ready.push(id);
    let visited = 0;
    while (ready.size > 0) {
      const id = ready.pop()!;
      visited += 1;
      for (const dependent of this.dependents.get(id) ?? []) {
        const next = (remaining.get(dependent) ?? 0) - 1;
        remaining.set(dependent, next);
        if (next === 0) ready.push(dependent);
      }
    }
    if (visited !== this.tasks.length) {
      const cycle = this.tasks.map((task) => task.id).filter((id) => (remaining.get(id) ?? 0) > 0);
      throw new AriadneError({
        category: "task_loading", code: "TASK_DEPENDENCY_CYCLE", stage: "validated",
        message: `Task dependency cycle detected among: ${cycle.join(", ")}.`,
        correction: "Remove at least one dependency edge from the cycle.", details: { cycle }
      });
    }
  }
}
