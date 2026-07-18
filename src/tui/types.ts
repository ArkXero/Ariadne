import type { BatchReportView } from "../core/workflow-report.js";
import type { RunReportView } from "../core/report.js";
import type {
  ActiveWorkflowRegistry, ResumeWorkflowPreview, RerunWorkflowPreview, WorkflowExecutionHandle,
  WorkflowExecutionOverrides, WorkflowInspection, WorkflowLaunchRequest, WorkflowPlanPreview
} from "../core/workflow-application.js";
import type { WorkflowRuntimeView } from "./runtime-state.js";
import type {
  BatchAttemptReference,
  BatchRecord,
  BatchTaskState,
  PromotionRecord,
  TaskOutcome,
  TaskStatus,
  WorkspaceRecord
} from "../types/index.js";

export type WarningCode =
  | "corrupt-record"
  | "future-record"
  | "missing-child"
  | "missing-artifact"
  | "missing-worktree"
  | "missing-result-ref"
  | "abandoned-owner"
  | "unsafe-path"
  | "configuration-missing"
  | "history-empty"
  | "unreadable";

export interface TuiWarning {
  id: string;
  code: WarningCode;
  message: string;
  path?: string;
  recordId?: string;
}

export type ResultState = "not-applicable" | "unapplied" | "applied" | "discarded" | "conflicted";

export interface AttemptReference extends BatchAttemptReference {
  key: string;
  manifestPath: string;
  final: boolean;
  taskIndex?: number;
  source: "batch" | "standalone" | "legacy";
}

export interface TaskHistoryEntry {
  key: string;
  source: AttemptReference["source"];
  batchId?: string;
  taskId: string;
  name: string;
  state: BatchTaskState | TaskStatus;
  outcome: TaskOutcome | "unknown";
  startedAt: string;
  durationMs: number;
  score: number | null;
  workspaceState?: string;
  resultState: ResultState;
  attempts: AttemptReference[];
  finalAttempt?: number;
  warnings: TuiWarning[];
}

export interface BatchHistoryEntry {
  key: string;
  record: BatchRecord;
  report: BatchReportView;
  resultStates: Record<string, ResultState>;
}

export interface DashboardAttention {
  unappliedResults: number;
  retainedWorktrees: number;
  failedWorkflows: number;
  warnings: number;
}

export interface TuiSnapshot {
  loadedAt: string;
  configuration: "available" | "missing" | "invalid";
  batches: BatchHistoryEntry[];
  tasks: TaskHistoryEntry[];
  workspaces: WorkspaceRecord[];
  promotions: PromotionRecord[];
  warnings: TuiWarning[];
  attention: DashboardAttention;
}

export interface AttemptDetail {
  reference: AttemptReference;
  report: RunReportView;
  taskIndex: number;
  resultState: ResultState;
}

export interface LogPreview {
  path: string;
  status: "ready" | "missing" | "unreadable" | "unsafe" | "binary";
  text: string;
  totalBytes: number;
  readBytes: number;
  truncated: boolean;
  message?: string;
}

export interface TuiDataService {
  loadSnapshot(): Promise<TuiSnapshot>;
  loadAttempt(reference: AttemptReference): Promise<AttemptDetail>;
  loadLogPreview(relativePath: string): Promise<LogPreview>;
  inspectWorkflowOptions?(): Promise<WorkflowInspection>;
  createWorkflowPlanPreview?(taskIds: string[], overrides: WorkflowExecutionOverrides): Promise<WorkflowPlanPreview>;
  previewResumeWorkflow?(batchId: string, overrides: Pick<WorkflowExecutionOverrides, "concurrency" | "allowDirtyBase">): Promise<ResumeWorkflowPreview>;
  previewRerunWorkflow?(batchId: string, mode: "failed" | "failed-branch" | "all", overrides: WorkflowExecutionOverrides): Promise<RerunWorkflowPreview>;
  startWorkflowExecution?(request: TuiWorkflowLaunchRequest): Promise<WorkflowExecutionHandle>;
  loadBatch?(batchId: string): Promise<BatchRecord>;
  cancellationTimeoutMs?(): Promise<number>;
  registry?: ActiveWorkflowRegistry;
}

export type HistoryMode = "batches" | "tasks";
export type HistoryFilter = "all" | "failed" | "running" | "unapplied" | "workspace";
export type OutputStream = "stdout" | "stderr";

export type Screen =
  | { kind: "dashboard"; selection: number }
  | { kind: "history"; mode: HistoryMode; filter: HistoryFilter; selection: number }
  | { kind: "workflow"; batchKey: string; selection: number; expandedTask?: string }
  | { kind: "task"; taskKey: string; selection: number }
  | { kind: "attempt"; taskKey: string; attemptIndex: number; processIndex: number; stream: OutputStream; scroll: number }
  | { kind: "warnings"; selection: number }
  | { kind: "planner"; selection: number }
  | { kind: "plan"; selection: number }
  | { kind: "options"; selection: number }
  | { kind: "confirm"; selection: number }
  | { kind: "live"; selection: number; processIndex: number; stream: OutputStream; scroll: number }
  | { kind: "cancel-confirm"; selection: number }
  | { kind: "cancel-progress"; selection: number }
  | { kind: "exit-confirm"; selection: number }
  | { kind: "resume-preview"; selection: number }
  | { kind: "rerun-preview"; selection: number }
  | { kind: "help" };

export interface WorkflowDraftState {
  taskIds: string[];
  overrides: WorkflowExecutionOverrides;
  optionBaseline: WorkflowExecutionOverrides;
  sourceBatchId?: string;
  relation?: "resume" | "failed" | "failed-branch" | "all";
}

export interface TuiOperationalState {
  loading: boolean;
  error?: string;
  inspection?: WorkflowInspection;
  preview?: WorkflowPlanPreview;
  resumePreview?: ResumeWorkflowPreview;
  rerunPreview?: RerunWorkflowPreview;
  draft: WorkflowDraftState;
  runtime?: WorkflowRuntimeView;
  cancellationRequested: boolean;
  detached: boolean;
  clock: number;
}

export interface RequestState {
  generation: number;
  loading: boolean;
  error?: string;
}

export interface TuiState {
  screen: Screen;
  backStack: Screen[];
  snapshot?: TuiSnapshot;
  snapshotRequest: RequestState;
  attempts: Record<string, AttemptDetail>;
  attemptRequests: Record<string, RequestState>;
  logs: Record<string, LogPreview>;
  logRequests: Record<string, RequestState>;
}

type WithoutCwd<T> = T extends unknown ? Omit<T, "cwd"> : never;
export type TuiWorkflowLaunchRequest = WithoutCwd<WorkflowLaunchRequest>;
