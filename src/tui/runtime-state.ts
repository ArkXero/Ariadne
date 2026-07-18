import { sanitizeTerminalText } from "./sanitize.js";
import type { WorkflowRuntimeEvent, WorkflowProcessPhase, WorkflowOutputStream } from "../core/workflow-runtime.js";
import type { BatchRecord, BatchSummary, BatchTaskState, TaskOutcome, WorkflowPlan } from "../types/index.js";

export const MAX_LIVE_OUTPUT_LINES = 500;
export const MAX_LIVE_OUTPUT_BYTES = 256 * 1024;

export interface LiveOutputBuffer {
  lines: string[];
  partial: string;
  bytes: number;
  truncated: boolean;
  lastStreamSequence: number;
}

export interface LiveProcessState {
  key: string;
  attempt: number;
  runId: string;
  phase: WorkflowProcessPhase;
  commandIndex: number;
  displayCommand: string;
  status: "running" | "passed" | "failed" | "interrupted";
  exitCode?: number | null;
  timedOut?: boolean;
  spawnError?: string;
  stdout: LiveOutputBuffer;
  stderr: LiveOutputBuffer;
}

export interface LiveTaskState {
  id: string;
  name: string;
  state: BatchTaskState;
  attempt: number;
  runId?: string;
  outcome?: TaskOutcome;
  retryAt?: string;
  retryReason?: string;
  blockedBy: string[];
  blockReason?: string;
  processes: LiveProcessState[];
}

export interface WorkflowRuntimeView {
  batchId: string;
  plan: WorkflowPlan;
  startedAt: string;
  status: BatchRecord["batchStatus"];
  summary: BatchSummary;
  tasks: LiveTaskState[];
  warnings: string[];
  cancellationStage?: Extract<WorkflowRuntimeEvent, { type: "batch.cancellation_progress" }>["stage"];
  completedManifest?: string;
  lastSequence: number;
}

function emptyBuffer(): LiveOutputBuffer {
  return { lines: [], partial: "", bytes: 0, truncated: false, lastStreamSequence: 0 };
}

function initialSummary(total: number): BatchSummary {
  return { total, succeeded: 0, failed: 0, blocked: 0, skipped: 0, interrupted: 0, incomplete: 0, retried: 0, score: null, status: "running", outcome: "passed" };
}

export function createRuntimeView(batchId: string, plan: WorkflowPlan, startedAt: string): WorkflowRuntimeView {
  return {
    batchId,
    plan,
    startedAt,
    status: "running",
    summary: initialSummary(plan.tasks.length),
    tasks: plan.tasks.map((task) => ({ id: task.id, name: task.name, state: "pending", attempt: 0, blockedBy: [], processes: [] })),
    warnings: [],
    lastSequence: 0
  };
}

function trimToByteLimit(value: string, maximum: number): string {
  if (Buffer.byteLength(value) <= maximum) return value;
  let start = 0;
  while (start < value.length && Buffer.byteLength(value.slice(start)) > maximum) start += Math.max(1, Math.floor((value.length - start) / 8));
  return value.slice(start);
}

export function appendLiveOutput(buffer: LiveOutputBuffer, chunk: string, streamSequence: number): LiveOutputBuffer {
  if (streamSequence <= buffer.lastStreamSequence) return buffer;
  const gap = streamSequence > buffer.lastStreamSequence + 1;
  const safe = sanitizeTerminalText(chunk);
  const pieces = `${buffer.partial}${safe}`.split("\n");
  let partial = pieces.pop() ?? "";
  const lines = [...buffer.lines, ...pieces];
  let truncated = buffer.truncated || gap;
  while (lines.length > MAX_LIVE_OUTPUT_LINES) {
    lines.shift();
    truncated = true;
  }
  partial = trimToByteLimit(partial, MAX_LIVE_OUTPUT_BYTES);
  let bytes = Buffer.byteLength(partial) + lines.reduce((total, line) => total + Buffer.byteLength(line) + 1, 0);
  while (bytes > MAX_LIVE_OUTPUT_BYTES && lines.length > 0) {
    const removed = lines.shift()!;
    bytes -= Buffer.byteLength(removed) + 1;
    truncated = true;
  }
  if (bytes > MAX_LIVE_OUTPUT_BYTES) {
    partial = trimToByteLimit(partial, MAX_LIVE_OUTPUT_BYTES);
    bytes = Buffer.byteLength(partial);
    truncated = true;
  }
  return { lines, partial, bytes, truncated, lastStreamSequence: streamSequence };
}

export function liveOutputText(buffer: LiveOutputBuffer): string {
  const content = [...buffer.lines, ...(buffer.partial ? [buffer.partial] : [])].join("\n");
  return `${buffer.truncated ? "[earlier output truncated]\n" : ""}${content || "No live output."}`;
}

function processKey(runId: string, phase: WorkflowProcessPhase, commandIndex: number): string {
  return `${runId}:${phase}:${commandIndex}`;
}

function ensureProcess(task: LiveTaskState, attempt: number, runId: string, phase: WorkflowProcessPhase, commandIndex: number, displayCommand = "Starting..."): LiveProcessState {
  const key = processKey(runId, phase, commandIndex);
  let process = task.processes.find((item) => item.key === key);
  if (!process) {
    process = { key, attempt, runId, phase, commandIndex, displayCommand, status: "running", stdout: emptyBuffer(), stderr: emptyBuffer() };
    task.processes.push(process);
    task.processes.sort((left, right) => {
      const rank = (value: WorkflowProcessPhase) => value === "preparation" ? 0 : value === "agent" ? 1 : 2;
      return left.attempt - right.attempt || rank(left.phase) - rank(right.phase) || left.commandIndex - right.commandIndex;
    });
  }
  return process;
}

function taskFor(view: WorkflowRuntimeView, taskId: string): LiveTaskState | undefined {
  return view.tasks.find((task) => task.id === taskId);
}

const RUNTIME_EVENT_TYPES = new Set([
  "batch.started", "batch.state", "task.ready", "task.started", "attempt.started", "process.started", "process.output",
  "process.completed", "task.retry_scheduled", "task.blocked", "task.completed", "batch.cancellation_requested",
  "batch.cancellation_progress", "runtime.warning", "batch.completed"
]);

export function isWorkflowRuntimeEvent(event: unknown): event is WorkflowRuntimeEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  if (typeof value.batchId !== "string" || typeof value.timestamp !== "string" || !Number.isInteger(value.sequence) || Number(value.sequence) < 1) return false;
  if (typeof value.type !== "string" || !RUNTIME_EVENT_TYPES.has(value.type)) return false;
  if (value.type === "process.output") {
    return typeof value.taskId === "string" && typeof value.runId === "string" && typeof value.chunk === "string"
      && (value.stream === "stdout" || value.stream === "stderr") && Number.isInteger(value.streamSequence) && Number(value.streamSequence) > 0;
  }
  return true;
}

/** Applies provisional runtime events. Final status and score still come from persistence reconciliation. */
export function reduceRuntimeEvent(current: WorkflowRuntimeView, event: WorkflowRuntimeEvent | unknown): WorkflowRuntimeView {
  if (!isWorkflowRuntimeEvent(event)) {
    const view = structuredClone(current);
    view.warnings = [...new Set([...view.warnings, "Ignored a malformed runtime event."])].slice(-50);
    return view;
  }
  if (event.batchId !== current.batchId || event.sequence <= current.lastSequence) return current;
  const view = structuredClone(current);
  if (event.sequence > current.lastSequence + 1) view.warnings.push(`Runtime event sequence gap: expected ${current.lastSequence + 1}, received ${event.sequence}.`);
  view.lastSequence = event.sequence;
  if (event.type === "batch.state") {
    view.status = event.status;
    view.summary = { ...event.summary };
  } else if (event.type === "task.ready") {
    const task = taskFor(view, event.taskId);
    if (task) task.state = "ready";
  } else if (event.type === "task.started") {
    const task = taskFor(view, event.taskId);
    if (task) { task.state = "running"; task.attempt = event.attempt; task.retryAt = undefined; task.retryReason = undefined; }
  } else if (event.type === "attempt.started") {
    const task = taskFor(view, event.taskId);
    if (task) { task.attempt = event.attempt; task.runId = event.runId; }
  } else if (event.type === "process.started") {
    const task = taskFor(view, event.taskId);
    if (task) {
      task.state = "running";
      task.attempt = event.attempt;
      task.runId = event.runId;
      const process = ensureProcess(task, event.attempt, event.runId, event.phase, event.commandIndex, event.displayCommand);
      process.displayCommand = event.displayCommand;
      process.status = "running";
    }
  } else if (event.type === "process.output") {
    const task = taskFor(view, event.taskId);
    if (task) {
      const process = ensureProcess(task, event.attempt, event.runId, event.phase, event.commandIndex);
      const stream: WorkflowOutputStream = event.stream;
      process[stream] = appendLiveOutput(process[stream], event.chunk, event.streamSequence);
    }
  } else if (event.type === "process.completed") {
    const task = taskFor(view, event.taskId);
    if (task) {
      const process = ensureProcess(task, event.attempt, event.runId, event.phase, event.commandIndex);
      process.status = event.status;
      process.exitCode = event.exitCode;
      process.timedOut = event.timedOut;
      process.spawnError = event.spawnError;
    }
  } else if (event.type === "task.retry_scheduled") {
    const task = taskFor(view, event.taskId);
    if (task) { task.state = "retry_wait"; task.attempt = event.currentAttempt; task.retryAt = event.retryAt; task.retryReason = event.reason; }
  } else if (event.type === "task.blocked") {
    const task = taskFor(view, event.taskId);
    if (task) { task.state = "blocked"; task.blockedBy = [...event.blockedBy]; task.blockReason = event.reason; task.attempt = 0; }
  } else if (event.type === "task.completed") {
    const task = taskFor(view, event.taskId);
    if (task) {
      task.state = event.state;
      task.attempt = event.attempt;
      task.runId = event.runId ?? task.runId;
      task.outcome = event.outcome;
      task.retryAt = undefined;
    }
  } else if (event.type === "batch.cancellation_requested") {
    view.cancellationStage ??= "launches-stopped";
  } else if (event.type === "batch.cancellation_progress") {
    const stages = ["launches-stopped", "retry-delays-cancelled", "processes-terminating", "tasks-finalizing", "batch-finalizing"] as const;
    if (!view.cancellationStage || stages.indexOf(event.stage) >= stages.indexOf(view.cancellationStage)) view.cancellationStage = event.stage;
  } else if (event.type === "runtime.warning") {
    view.warnings.push(event.taskId ? `${event.taskId}: ${event.message}` : event.message);
  } else if (event.type === "batch.completed") {
    view.status = event.status;
    view.completedManifest = event.manifest;
  }
  view.warnings = [...new Set(view.warnings)].slice(-50);
  return view;
}

export function reconcileRuntimeRecord(current: WorkflowRuntimeView, batch: BatchRecord): WorkflowRuntimeView {
  if (batch.batchId !== current.batchId) return current;
  const view = structuredClone(current);
  view.status = batch.batchStatus;
  view.summary = { ...batch.summary };
  for (const persisted of batch.tasks) {
    const task = taskFor(view, persisted.id);
    if (!task) continue;
    task.state = persisted.state;
    task.attempt = persisted.finalAttempt ?? task.attempt;
    task.outcome = persisted.finalOutcome;
    task.blockedBy = persisted.blockReason ? [...persisted.blockReason.chain] : task.blockedBy;
    task.blockReason = persisted.blockReason?.message ?? task.blockReason;
    const final = persisted.finalAttempt === undefined ? undefined : persisted.attempts.find((attempt) => attempt.attempt === persisted.finalAttempt);
    task.runId = final?.runId ?? task.runId;
  }
  if (batch.status !== "running") view.completedManifest = batch.artifacts.manifest;
  return view;
}
