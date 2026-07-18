import type { BatchReportView } from "../core/workflow-report.js";
import type { RunReportView } from "../core/report.js";
import type {
  ActiveWorkflowRegistry, ResumeWorkflowPreview, RerunWorkflowPreview, WorkflowExecutionHandle,
  WorkflowExecutionOverrides, WorkflowInspection, WorkflowLaunchRequest, WorkflowPlanPreview
} from "../core/workflow-application.js";
import type { WorkflowRuntimeView } from "./runtime-state.js";
import type {
  ApplyEligibility,
  ApplyPreview,
  AttemptComparison,
  FileDiffPage,
  PatchExportPreview,
  ResultSummary,
  ReviewResult,
  ReviewResultFilter
} from "../core/change-application.js";
import type {
  WorkspaceCleanupPreview,
  WorkspaceCleanupResult,
  WorkspaceDetail
} from "../core/workspace-application.js";
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
  conflictedResults: number;
  applicationFailures: number;
  ineligibleResults: number;
  missingOrCorruptResults: number;
  retainedWorktrees: number;
  staleWorktrees: number;
  cleanupFailures: number;
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
  results: ReviewResult[];
  workspaceDetails: WorkspaceDetail[];
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
  loadResultSummary?(runId: string): Promise<ResultSummary>;
  loadFileDiff?(runId: string, changeIdOrPath: string, cursor?: string): Promise<FileDiffPage>;
  compareAttemptResults?(leftRunId: string, rightRunId: string): Promise<AttemptComparison>;
  inspectApplyEligibility?(runId: string): Promise<ApplyEligibility>;
  previewApplyResult?(runId: string): Promise<ApplyPreview>;
  applyReviewedResult?(runId: string, fingerprint: string, onProgress?: (stage: string) => void, signal?: AbortSignal): Promise<PromotionRecord>;
  previewDiscardResult?(runId: string): Promise<import("../core/promotion.js").DiscardPreview>;
  discardReviewedResult?(runId: string, onProgress?: (stage: string) => void, signal?: AbortSignal): Promise<PromotionRecord>;
  previewPatchExport?(runId: string): Promise<PatchExportPreview>;
  exportPatch?(runId: string, destination: string, onProgress?: (stage: string) => void, signal?: AbortSignal): Promise<{ path: string }>;
  loadWorkspaceDetail?(workspaceId: string): Promise<WorkspaceDetail>;
  previewWorkspaceCleanup?(workspaceId: string): Promise<WorkspaceCleanupPreview>;
  previewEligibleWorkspaceCleanup?(): Promise<WorkspaceCleanupPreview>;
  cleanWorkspace?(workspaceId: string, onProgress?: (stage: string) => void, signal?: AbortSignal): Promise<WorkspaceCleanupResult>;
  cleanEligibleWorkspaces?(onProgress?: (stage: string) => void, signal?: AbortSignal): Promise<WorkspaceCleanupResult>;
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
export type WorkspaceReviewFilter = "all" | "retained" | "stale" | "cleanup-failure";

export type Screen =
  | { kind: "dashboard"; selection: number; focus?: "workflows" | "attention" }
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
  | { kind: "results"; filter: ReviewResultFilter; selection: number }
  | { kind: "result"; runId: string; selection: number }
  | { kind: "changes"; runId: string; selection: number }
  | { kind: "diff"; runId: string; fileIndex: number; cursor?: string; scroll: number }
  | { kind: "compare"; runId: string; otherRunId: string; selection: number }
  | { kind: "apply-eligibility"; runId: string; selection: number }
  | { kind: "apply-preview"; runId: string; selection: number }
  | { kind: "apply-confirm"; runId: string; selection: number }
  | { kind: "discard-preview"; runId: string; selection: number }
  | { kind: "discard-confirm"; runId: string; selection: number }
  | { kind: "export-preview"; runId: string; selection: number }
  | { kind: "workspaces"; filter?: WorkspaceReviewFilter; selection: number }
  | { kind: "workspace"; workspaceId: string; selection: number }
  | { kind: "cleanup-preview"; workspaceId?: string; selection: number }
  | { kind: "cleanup-confirm"; workspaceId?: string; selection: number }
  | { kind: "action-result"; selection: number }
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
  reviewLoading: boolean;
  reviewError?: string;
  resultSummary?: ResultSummary;
  diffPage?: FileDiffPage;
  comparison?: AttemptComparison;
  applyEligibility?: ApplyEligibility;
  applyPreview?: ApplyPreview;
  discardPreview?: import("../core/promotion.js").DiscardPreview;
  patchExportPreview?: PatchExportPreview;
  workspaceDetail?: WorkspaceDetail;
  cleanupPreview?: WorkspaceCleanupPreview;
  cleanupResult?: WorkspaceCleanupResult;
  promotionResult?: PromotionRecord;
  actionMessage?: string;
  actionProgress?: string;
  actionLocked: boolean;
  riskAcknowledged: boolean;
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
