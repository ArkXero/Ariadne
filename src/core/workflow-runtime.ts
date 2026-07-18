import type { BatchStatus, BatchSummary, BatchTaskState, TaskOutcome } from "../types/index.js";

export type WorkflowProcessPhase = "preparation" | "agent" | "verification";
export type WorkflowOutputStream = "stdout" | "stderr";

interface RuntimeEventBase {
  readonly batchId: string;
  readonly timestamp: string;
  readonly sequence: number;
}

export type WorkflowRuntimeEvent = Readonly<RuntimeEventBase & (
  | { type: "batch.started"; startedAt: string; planId: string }
  | { type: "batch.state"; status: BatchStatus; summary: Readonly<BatchSummary> }
  | { type: "task.ready"; taskId: string }
  | { type: "task.started"; taskId: string; attempt: number }
  | { type: "attempt.started"; taskId: string; attempt: number; runId: string }
  | { type: "process.started"; taskId: string; attempt: number; runId: string; phase: WorkflowProcessPhase; commandIndex: number; displayCommand: string }
  | { type: "process.output"; taskId: string; attempt: number; runId: string; phase: WorkflowProcessPhase; commandIndex: number; stream: WorkflowOutputStream; streamSequence: number; chunk: string }
  | { type: "process.completed"; taskId: string; attempt: number; runId: string; phase: WorkflowProcessPhase; commandIndex: number; status: "passed" | "failed" | "interrupted"; exitCode: number | null; timedOut: boolean; spawnError?: string }
  | { type: "task.retry_scheduled"; taskId: string; currentAttempt: number; nextAttempt: number; retryAt: string; reason: string }
  | { type: "task.blocked"; taskId: string; blockedBy: readonly string[]; reason: string }
  | { type: "task.completed"; taskId: string; attempt: number; runId?: string; state: BatchTaskState; outcome?: TaskOutcome }
  | { type: "batch.cancellation_requested" }
  | { type: "batch.cancellation_progress"; stage: "launches-stopped" | "retry-delays-cancelled" | "processes-terminating" | "tasks-finalizing" | "batch-finalizing"; detail?: string }
  | { type: "runtime.warning"; category: string; message: string; taskId?: string }
  | { type: "batch.completed"; status: BatchStatus; outcome: TaskOutcome; manifest: string }
)>;

type RuntimeEventPayload<T> = T extends RuntimeEventBase ? Omit<T, keyof RuntimeEventBase | "streamSequence"> : never;
export type WorkflowRuntimeEventPayload = RuntimeEventPayload<WorkflowRuntimeEvent>;
export type WorkflowRuntimeListener = (event: WorkflowRuntimeEvent) => void | Promise<void>;

export interface WorkflowRuntimeSnapshot {
  batchId: string;
  state: "starting" | "running" | "cancelling" | "completed";
  lastSequence: number;
  latestEvent?: WorkflowRuntimeEvent;
}

export interface WorkflowRuntimeEmitter {
  emit(event: WorkflowRuntimeEventPayload): void;
}

const MAX_SUBSCRIBER_EVENTS = 512;
const MAX_SUBSCRIBER_OUTPUT_BYTES = 1024 * 1024;

function outputBytes(event: WorkflowRuntimeEvent): number {
  return event.type === "process.output" ? Buffer.byteLength(event.chunk) : 0;
}

function replaceableKey(event: WorkflowRuntimeEvent): string | undefined {
  if (event.type === "batch.state") return event.type;
  if (["task.ready", "task.started", "task.retry_scheduled", "task.blocked", "task.completed"].includes(event.type) && "taskId" in event) return `task:${event.taskId}:state`;
  return undefined;
}

function immutableEvent<T>(value: T): T {
  const cloned = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== "object" || Object.isFrozen(item)) return;
    for (const child of Object.values(item as Record<string, unknown>)) freeze(child);
    Object.freeze(item);
  };
  freeze(cloned);
  return cloned;
}

class RuntimeSubscription {
  private queue: WorkflowRuntimeEvent[] = [];
  private queuedOutputBytes = 0;
  private draining = false;
  private closed = false;
  private droppedOutput = false;

  constructor(
    private readonly listener: WorkflowRuntimeListener,
    private readonly onFailure: (error: unknown) => void,
    private readonly onDrop: () => void
  ) {}

  enqueue(event: WorkflowRuntimeEvent): void {
    if (this.closed) return;
    const key = replaceableKey(event);
    if (key) {
      const existing = this.queue.findIndex((candidate) => replaceableKey(candidate) === key);
      if (existing >= 0) {
        this.queuedOutputBytes -= outputBytes(this.queue[existing]!);
        this.queue.splice(existing, 1);
        this.droppedOutput = true;
      }
    }
    this.queue.push(event);
    this.queuedOutputBytes += outputBytes(event);
    while (this.queue.length > MAX_SUBSCRIBER_EVENTS || this.queuedOutputBytes > MAX_SUBSCRIBER_OUTPUT_BYTES) {
      const index = this.queue.findIndex((candidate) => candidate.type === "process.output");
      if (index < 0) {
        this.closed = true;
        this.queue = [];
        this.queuedOutputBytes = 0;
        this.onFailure(new Error("Runtime subscriber could not keep up with non-droppable workflow events."));
        return;
      }
      const [removed] = this.queue.splice(index, 1);
      this.queuedOutputBytes -= outputBytes(removed!);
      this.droppedOutput = true;
    }
    if (this.droppedOutput) {
      this.droppedOutput = false;
      this.onDrop();
    }
    if (this.draining) return;
    this.draining = true;
    setImmediate(() => { void this.drain(); });
  }

  close(): void {
    this.closed = true;
    this.queue = [];
    this.queuedOutputBytes = 0;
  }

  private async drain(): Promise<void> {
    while (!this.closed && this.queue.length > 0) {
      const event = this.queue.shift()!;
      this.queuedOutputBytes -= outputBytes(event);
      try {
        await this.listener(event);
      } catch (error) {
        this.close();
        this.onFailure(error);
        break;
      }
    }
    this.draining = false;
    if (!this.closed && this.queue.length > 0) {
      this.draining = true;
      setImmediate(() => { void this.drain(); });
    }
  }
}

/** A bounded, process-local event channel. Persisted records remain authoritative. */
export class WorkflowRuntimeChannel implements WorkflowRuntimeEmitter {
  private sequence = 0;
  private readonly streamSequences = new Map<string, number>();
  private readonly subscriptions = new Set<RuntimeSubscription>();
  private readonly recent: WorkflowRuntimeEvent[] = [];
  private readonly activeProcesses = new Set<string>();
  private readonly retryingTasks = new Set<string>();
  private recentOutputBytes = 0;
  private snapshot: WorkflowRuntimeSnapshot;
  private dropWarningScheduled = false;

  constructor(readonly batchId: string) {
    this.snapshot = { batchId, state: "starting", lastSequence: 0 };
  }

  emit(payload: WorkflowRuntimeEventPayload): void {
    if (payload.type === "batch.completed" && this.dropWarningScheduled) {
      this.dropWarningScheduled = false;
      this.emitDropWarning();
    }
    const event = this.decorate(payload);
    this.trackProvisionalState(event);
    this.snapshot = {
      batchId: this.batchId,
      state: event.type === "batch.completed" ? "completed" : event.type === "batch.cancellation_requested" || event.type === "batch.cancellation_progress" ? "cancelling" : "running",
      lastSequence: event.sequence,
      latestEvent: event
    };
    this.remember(event);
    for (const subscription of this.subscriptions) subscription.enqueue(event);
  }

  subscribe(listener: WorkflowRuntimeListener): () => void {
    let subscription: RuntimeSubscription;
    subscription = new RuntimeSubscription(
      listener,
      () => {
        subscription.close();
        this.subscriptions.delete(subscription);
      },
      () => this.scheduleDropWarning()
    );
    this.subscriptions.add(subscription);
    for (const event of this.recent) subscription.enqueue(event);
    return () => {
      subscription.close();
      this.subscriptions.delete(subscription);
    };
  }

  latestSnapshot(): WorkflowRuntimeSnapshot {
    return structuredClone(this.snapshot);
  }

  emitCancellationHints(): void {
    this.emit({ type: "batch.cancellation_requested" });
    this.emit({ type: "batch.cancellation_progress", stage: "launches-stopped" });
    if (this.retryingTasks.size > 0) this.emit({ type: "batch.cancellation_progress", stage: "retry-delays-cancelled", detail: `${this.retryingTasks.size} retry delay${this.retryingTasks.size === 1 ? "" : "s"}` });
    if (this.activeProcesses.size > 0) this.emit({ type: "batch.cancellation_progress", stage: "processes-terminating", detail: `${this.activeProcesses.size} active process${this.activeProcesses.size === 1 ? "" : "es"}` });
  }

  private decorate(payload: WorkflowRuntimeEventPayload): WorkflowRuntimeEvent {
    const base = { batchId: this.batchId, timestamp: new Date().toISOString(), sequence: ++this.sequence };
    if (payload.type !== "process.output") return immutableEvent({ ...payload, ...base }) as WorkflowRuntimeEvent;
    const streamKey = `${payload.taskId}\0${payload.attempt}\0${payload.runId}\0${payload.phase}\0${payload.commandIndex}\0${payload.stream}`;
    const streamSequence = (this.streamSequences.get(streamKey) ?? 0) + 1;
    this.streamSequences.set(streamKey, streamSequence);
    return immutableEvent({ ...payload, ...base, streamSequence }) as WorkflowRuntimeEvent;
  }

  private remember(event: WorkflowRuntimeEvent): void {
    const key = replaceableKey(event);
    if (key) {
      const existing = this.recent.findIndex((candidate) => replaceableKey(candidate) === key);
      if (existing >= 0) {
        this.recentOutputBytes -= outputBytes(this.recent[existing]!);
        this.recent.splice(existing, 1);
      }
    }
    this.recent.push(event);
    this.recentOutputBytes += outputBytes(event);
    while (this.recent.length > MAX_SUBSCRIBER_EVENTS || this.recentOutputBytes > MAX_SUBSCRIBER_OUTPUT_BYTES) {
      const outputIndex = this.recent.findIndex((candidate) => candidate.type === "process.output");
      const index = outputIndex >= 0 ? outputIndex : this.recent.findIndex((candidate) => !["batch.cancellation_requested", "batch.cancellation_progress", "batch.completed"].includes(candidate.type));
      if (index < 0) break;
      const [removed] = this.recent.splice(index, 1);
      this.recentOutputBytes -= outputBytes(removed!);
    }
  }

  private trackProvisionalState(event: WorkflowRuntimeEvent): void {
    const processKey = "taskId" in event && "attempt" in event && "runId" in event && "phase" in event && "commandIndex" in event
      ? `${event.taskId}\0${event.attempt}\0${event.runId}\0${event.phase}\0${event.commandIndex}`
      : undefined;
    if (event.type === "process.started" && processKey) this.activeProcesses.add(processKey);
    if (event.type === "process.completed" && processKey) this.activeProcesses.delete(processKey);
    if (event.type === "task.retry_scheduled") this.retryingTasks.add(event.taskId);
    if (event.type === "task.started" || event.type === "task.completed") this.retryingTasks.delete(event.taskId);
    if (event.type === "batch.completed") {
      this.activeProcesses.clear();
      this.retryingTasks.clear();
    }
  }

  private scheduleDropWarning(): void {
    if (this.dropWarningScheduled) return;
    this.dropWarningScheduled = true;
    setImmediate(() => {
      if (!this.dropWarningScheduled || this.snapshot.state === "completed") return;
      this.dropWarningScheduled = false;
      this.emitDropWarning();
    });
  }

  private emitDropWarning(): void {
    this.emit({ type: "runtime.warning", category: "subscriber-overflow", message: "Live output events were dropped because a subscriber fell behind; persisted artifacts remain complete." });
  }
}
