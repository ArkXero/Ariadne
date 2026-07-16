import crypto from "node:crypto";
import { WorkflowGraph } from "./workflow-graph.js";
import { persistedCommand } from "./command-utils.js";
import type { AriadneConfig, FailureMode, IsolationStrategy, ProcessSpec, WorkflowPlan } from "../types/index.js";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, child]) => [key, stableValue(child)]));
  }
  return value;
}

function hash(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function compareIds(left: string, right: string): number {
  const lowerLeft = left.toLowerCase();
  const lowerRight = right.toLowerCase();
  return lowerLeft < lowerRight ? -1 : lowerLeft > lowerRight ? 1 : left < right ? -1 : left > right ? 1 : 0;
}

function specValue(spec: ProcessSpec): unknown {
  return spec.kind === "exec" ? { kind: spec.kind, file: spec.file, args: [...spec.args] } : { kind: spec.kind, command: spec.command };
}

function persistedSpec(spec: ProcessSpec): ProcessSpec {
  const persisted = persistedCommand(spec);
  return spec.kind === "exec"
    ? { kind: "exec", file: spec.file, args: persisted.args }
    : { kind: "shell", command: persisted.displayCommand };
}

export function semanticConfigFingerprint(
  graph: WorkflowGraph,
  config: AriadneConfig,
  failureMode = config.execution.failure_mode,
  isolation = config.execution.isolation
): string {
  return hash({
    version: config.version,
    agent: { command: specValue(config.agent.command), timeout_ms: config.agent.timeout_ms },
    verification: { commands: config.verification.commands.map(specValue), timeout_ms: config.verification.timeout_ms },
    execution: {
      termination_grace_ms: config.execution.termination_grace_ms,
      configured_failure_mode: config.execution.failure_mode,
      effective_failure_mode: failureMode,
      configured_isolation: config.execution.isolation,
      effective_isolation: isolation,
      retention: config.execution.worktree.retention,
      preparation: {
        commands: config.execution.worktree.preparation.commands.map(specValue),
        timeout_ms: config.execution.worktree.preparation.timeout_ms
      },
      dependency_results: "layer-successful-results"
    },
    checks: config.checks,
    tasks: graph.tasks.map((task) => ({
      id: task.id,
      name: task.name,
      file: task.file,
      promptSha256: hash(task.prompt),
      metadataSha256: hash(task.metadata ?? null),
      dependsOn: [...graph.dependencyIds(task.id)],
      workspaceMode: task.workspaceMode,
      retry: task.retry,
      verify: task.verify?.map(specValue) ?? null
    }))
  });
}

export function buildWorkflowPlan(options: {
  graph: WorkflowGraph;
  config: AriadneConfig;
  selectedIds?: readonly string[];
  concurrency?: number;
  failureMode?: FailureMode;
  isolation?: IsolationStrategy;
  dirtyBaseAcknowledged?: boolean;
  createdAt?: Date;
}): WorkflowPlan {
  const selectedRoots = options.selectedIds && options.selectedIds.length > 0
    ? [...new Set(options.selectedIds.map((id) => options.graph.require(id).id))].sort(compareIds)
    : options.graph.tasks.map((task) => task.id);
  const includedTasks = options.graph.closure(selectedRoots);
  const { order, levels } = options.graph.topological(includedTasks);
  const concurrency = options.concurrency ?? options.config.execution.concurrency;
  const failureMode = options.failureMode ?? options.config.execution.failure_mode;
  const isolation = options.isolation ?? options.config.execution.isolation;
  const configFingerprint = semanticConfigFingerprint(options.graph, options.config, failureMode, isolation);
  const selected = new Set(selectedRoots);
  const edges = order.flatMap((id) => options.graph.dependencyIds(id)
    .filter((dependency) => includedTasks.includes(dependency))
    .map((dependency) => ({ from: dependency, to: id })))
    .sort((left, right) => compareIds(left.from, right.from) || compareIds(left.to, right.to));
  const tasks = order.map((id, index) => {
    const task = options.graph.require(id);
    return {
      id,
      name: task.name,
      file: task.file,
      dependencies: [...options.graph.dependencyIds(id)].filter((dependency) => includedTasks.includes(dependency)),
      level: levels.findIndex((level) => level.includes(id)),
      order: index,
      selected: selected.has(id),
      workspaceMode: task.workspaceMode,
      retry: { ...task.retry },
      verification: (task.verify ?? options.config.verification.commands).map(persistedSpec)
    };
  });
  const plannedById = new Map(tasks.map((task) => [task.id, task]));
  const concurrencyGroups = levels.flatMap((level) => {
    const groups: string[][] = [];
    for (const id of level) {
      if (isolation === "worktree" || plannedById.get(id)?.workspaceMode === "read-only") {
        const previous = groups.at(-1);
        if (previous && previous.length < concurrency && previous.every((candidate) => isolation === "worktree" || plannedById.get(candidate)?.workspaceMode === "read-only")) previous.push(id);
        else groups.push([id]);
      } else groups.push([id]);
    }
    return groups;
  });
  const planId = hash({ configFingerprint, selectedRoots, includedTasks, edges, levels, concurrencyGroups, order, tasks, concurrency, failureMode, isolation, retention: options.config.execution.worktree.retention, dirtyBaseAcknowledged: options.dirtyBaseAcknowledged ?? false }).slice(0, 24);
  return {
    schemaVersion: 2,
    planId,
    createdAt: (options.createdAt ?? new Date()).toISOString(),
    configFingerprint,
    selectedRoots,
    includedTasks,
    edges,
    levels,
    concurrencyGroups,
    order,
    tasks,
    concurrency,
    failureMode,
    isolation,
    retention: options.config.execution.worktree.retention,
    dirtyBaseAcknowledged: options.dirtyBaseAcknowledged ?? false
  };
}
