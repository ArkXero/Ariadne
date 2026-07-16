export const CURRENT_CONFIG_VERSION = 4 as const;
export const CURRENT_RUN_SCHEMA_VERSION = 4 as const;
export const CURRENT_BATCH_SCHEMA_VERSION = 2 as const;
export const CURRENT_WORKSPACE_SCHEMA_VERSION = 1 as const;
export const CURRENT_PROMOTION_SCHEMA_VERSION = 1 as const;

export type LegacyConfigVersion = "versionless" | 1 | 2 | 3;
export type IsolationStrategy = "shared" | "worktree";
export type WorktreeRetention = "always" | "on-failure" | "never";
export type WorkspaceMode = "mutable" | "read-only";

export type ProcessSpec =
  | {
      kind: "exec";
      file: string;
      args: string[];
    }
  | {
      kind: "shell";
      command: string;
    };

export interface AriadneConfig {
  version: typeof CURRENT_CONFIG_VERSION;
  sourceVersion: LegacyConfigVersion | typeof CURRENT_CONFIG_VERSION;
  agent: {
    command: ProcessSpec;
    timeout_ms: number;
  };
  tasks: {
    directory: string;
  };
  verification: {
    commands: ProcessSpec[];
    timeout_ms: number;
  };
  execution: {
    termination_grace_ms: number;
    concurrency: number;
    failure_mode: FailureMode;
    isolation: IsolationStrategy;
    worktree: {
      retention: WorktreeRetention;
      preparation: {
        commands: ProcessSpec[];
        timeout_ms: number;
      };
    };
  };
  checks: {
    forbidden_files: string[];
    max_changed_files?: number;
    max_diff_lines?: number;
    forbidden_commands: string[];
  };
}

export interface LoadedConfig {
  config: AriadneConfig;
  path: string;
  projectRoot: string;
  warnings: string[];
}

export interface AriadneTask {
  id: string;
  name: string;
  file: string;
  prompt: string;
  metadata?: Record<string, unknown>;
  dependsOn: string[];
  workspaceMode: WorkspaceMode;
  retry: RetryPolicy;
  verify?: ProcessSpec[];
}

export type FailureMode = "continue" | "fail-fast";
export type RetryBackoff = "fixed" | "exponential";

export interface RetryPolicy {
  attempts: number;
  delayMs: number;
  backoff: RetryBackoff;
}

export type LifecycleStage =
  | "created"
  | "loading"
  | "validated"
  | "workspace_creating"
  | "workspace_ready"
  | "preparing"
  | "agent_running"
  | "agent_finished"
  | "verifying"
  | "collecting_trace"
  | "capturing_changes"
  | "workspace_cleanup"
  | "evaluating_policy"
  | "scoring"
  | "persisting"
  | "completed";

export type RunStatus = "running" | "completed" | "failed" | "interrupted" | "incomplete" | "abandoned";
export type TaskStatus = "running" | "passed" | "failed" | "interrupted" | "incomplete";

export type FailureCategory =
  | "configuration"
  | "task_loading"
  | "task_selection"
  | "repository_validation"
  | "workspace_preparation"
  | "workspace_management"
  | "promotion_conflict"
  | "agent_spawn"
  | "agent_nonzero"
  | "agent_timeout"
  | "verification_spawn"
  | "verification_nonzero"
  | "trace_collection"
  | "policy_violation"
  | "persistence"
  | "user_interruption"
  | "internal";

export interface FailureRecord {
  category: FailureCategory;
  code: string;
  stage: LifecycleStage;
  message: string;
  source?: string;
  taskId?: string;
  details?: Record<string, unknown>;
}

export interface LifecycleEvent {
  stage: LifecycleStage;
  at: string;
  taskId?: string;
  detail?: string;
}

export interface OutputPreview {
  head: string;
  tail: string;
  bytes: number;
  encoding: "utf8-replacement";
  hadDecodingReplacement: boolean;
}

export interface ProcessCleanupResult {
  attempted: boolean;
  limitation?: string;
  gracefulSignal?: string;
  forceSignal?: string;
  gracefulSucceeded?: boolean;
  forceSucceeded?: boolean;
  error?: string;
}

export interface ProcessResult {
  kind: ProcessSpec["kind"];
  executable: string;
  args: string[];
  displayCommand: string;
  cwd: string;
  providedEnvironmentKeys: string[];
  startedAt: string;
  completedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  interrupted: boolean;
  spawnError?: string;
  stdoutArtifact: string;
  stderrArtifact: string;
  stdoutPreview: OutputPreview;
  stderrPreview: OutputPreview;
  cleanup: ProcessCleanupResult;
  redactionApplied?: boolean;
}

export type RepositoryChangeType =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "mode-changed"
  | "symlink-changed"
  | "untracked"
  | "ignored";

export interface RepositoryEntry {
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  changeType: RepositoryChangeType;
  kind?: "file" | "symlink" | "other";
  mode?: string;
  fingerprint?: string;
}

export interface RepositorySnapshot {
  available: boolean;
  unavailableReason?: string;
  head?: string;
  branch?: string;
  detached?: boolean;
  dirty: boolean;
  entries: RepositoryEntry[];
  diffLineCount: number;
}

export interface ChangeEvidence {
  path: string;
  originalPath?: string;
  changeType: RepositoryChangeType;
  source: "preparation" | "agent" | "verification" | "multiple" | "agent-and-verification";
  baselineFingerprint?: string;
  finalFingerprint?: string;
}

export interface ForbiddenFileEvidence extends ChangeEvidence {
  rule: string;
  baselineState?: { fingerprint: string; kind: "file" | "symlink" | "other"; mode: string };
  finalState?: { fingerprint: string; kind: "file" | "symlink" | "other"; mode: string };
}

export interface ObservedCommand {
  source: "preparation-config" | "agent-config" | "verification-config" | "preparation-output" | "agent-output" | "verification-output";
  representation: string;
  confidence: "executed" | "reported" | "blocked";
}

export interface RepositoryTrace {
  baseline: RepositorySnapshot;
  postPreparation?: RepositorySnapshot;
  postAgent: RepositorySnapshot;
  final: RepositorySnapshot;
  preexistingChanges: RepositoryEntry[];
  preparationChanges: ChangeEvidence[];
  agentChanges: ChangeEvidence[];
  verificationChanges: ChangeEvidence[];
  taskChanges: ChangeEvidence[];
  forbiddenFileChanges: ForbiddenFileEvidence[];
  diffArtifact?: string;
  diffLineCount: number;
  observedCommands: ObservedCommand[];
}

export type PolicyOutcome = "pass" | "fail" | "warning" | "not-applicable";

export interface PolicyResult {
  ruleId: "files.forbidden" | "commands.forbidden" | "changes.max-files" | "changes.max-diff-lines" | "workspace.read-only";
  outcome: PolicyOutcome;
  penalty: number;
  summary: string;
  evidence: Record<string, unknown>;
}

export interface ScoreBreakdown {
  value: number;
  minimum: 0;
  maximum: 100;
  basis: "policy";
  deductions: Array<{
    ruleId: PolicyResult["ruleId"];
    penalty: number;
  }>;
}

export type TaskOutcome = "passed" | "preparation_failed" | "agent_failed" | "verification_failed" | "policy_failed" | "timeout" | "interrupted" | "internal_failed";

export interface PersistedTask {
  id: string;
  name: string;
  file: string;
  promptSha256: string;
  promptLength: number;
  metadata?: Record<string, unknown>;
}

export interface VerificationResult {
  displayCommand: string;
  command?: ProcessResult;
  status: "passed" | "failed" | "skipped";
  skipReason?: string;
}

export interface SensitivePathEvidence {
  path: string;
  reason: string;
  rule?: string;
  kind?: RepositoryEntry["kind"];
  size?: number;
  sha256?: string;
}

export interface CapturedChange {
  path: string;
  originalPath?: string;
  changeType: RepositoryChangeType;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  mode?: string;
  kind?: RepositoryEntry["kind"];
}

export interface ChangeArtifact {
  schemaVersion: 1;
  state: "captured" | "empty" | "incomplete";
  sourceRevision: string;
  preparedRevision: string;
  resultRevision?: string;
  resultRef?: string;
  patchArtifact?: string;
  previewArtifact?: string;
  manifestArtifact: string;
  changes: CapturedChange[];
  omittedSensitive: SensitivePathEvidence[];
  applicable: boolean;
  ineligibleReason?: string;
}

export type WorkspaceState = "creating" | "ready" | "preparing" | "running" | "capturing" | "retained" | "removing" | "removed" | "stale" | "failed";

export interface WorkspaceReference {
  workspaceId: string;
  strategy: IsolationStrategy;
  workspacePath?: string;
  metadataPath?: string;
  sourceRevision?: string;
  preparedRevision?: string;
  sourceDirty: boolean;
  dirtyBaseAcknowledged: boolean;
  excludedSourceChanges: RepositoryEntry[];
  repositoryId?: string;
  state: WorkspaceState;
  retention: WorktreeRetention;
  retentionReason?: string;
  cleanupAt?: string;
  cleanupError?: string;
  inheritedResults: Array<{ taskId: string; runId: string; resultRevision: string }>;
  preparation: ProcessResult[];
}

export interface TaskRunResult {
  task: PersistedTask;
  status: TaskStatus;
  outcome: TaskOutcome;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  lifecycle: LifecycleEvent[];
  agent?: ProcessResult;
  verification: VerificationResult[];
  trace?: RepositoryTrace;
  policies: PolicyResult[];
  score: ScoreBreakdown;
  failures: FailureRecord[];
}

export interface RunOwner {
  pid: number;
  hostname: string;
  startedAt: string;
}

export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  interrupted: number;
  status: RunStatus;
  outcome: TaskOutcome;
}

export interface RunRecord {
  schemaVersion: 2 | 3 | typeof CURRENT_RUN_SCHEMA_VERSION;
  runId: string;
  status: RunStatus;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  durationMs?: number;
  ariadneVersion: string;
  environment: {
    node: string;
    platform: NodeJS.Platform;
    release: string;
    arch: string;
  };
  owner: RunOwner;
  project: {
    root: ".";
    configPath?: string;
    repository?: {
      head?: string;
      branch?: string;
      detached?: boolean;
    };
  };
  config?: AriadneConfig;
  compatibilityWarnings: string[];
  lifecycle: LifecycleEvent[];
  results: TaskRunResult[];
  summary: RunSummary;
  failures: FailureRecord[];
  artifacts: {
    manifest: string;
    report?: string;
  };
  workflow?: {
    batchId: string;
    planId: string;
    taskId: string;
    attempt: number;
  };
  workspace?: WorkspaceReference;
  changeArtifact?: ChangeArtifact;
}

export interface RunPaths {
  runsDirectory: string;
  runDirectory: string;
  manifestPath: string;
  relativeManifestPath: string;
  latestPointerPath: string;
}

export interface LegacyCommandExecution {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  runtimeMs: number;
  startedAt: string;
  completedAt: string;
  timedOut: boolean;
}

export interface LegacyTaskRunResult {
  task: { id: string; name: string; file: string; prompt?: string; metadata?: Record<string, unknown> };
  durationMs?: number;
  agent: LegacyCommandExecution;
  verification: LegacyCommandExecution[];
  trace?: {
    gitAvailable?: boolean;
    workspaceDirtyBefore?: string[];
    changedFiles?: string[];
    forbiddenFileChanges?: string[];
    diff?: string;
    diffLineCount?: number;
    commandsObserved?: string[];
  };
  score: {
    passed: boolean;
    status?: string;
    checks?: Array<{ name: string; passed: boolean; message: string; details?: Record<string, unknown> }>;
  };
}

export interface LegacyRunRecord {
  schemaVersion?: number;
  version?: number;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  cwd?: string;
  configPath?: string;
  results?: LegacyTaskRunResult[];
  summary?: { total?: number; passed?: number; failed?: number; status?: string };
}

export type AnyRunRecord = RunRecord | LegacyRunRecord;

export interface WorkflowEdge {
  from: string;
  to: string;
}

export interface WorkflowPlanTask {
  id: string;
  name: string;
  file: string;
  dependencies: string[];
  level: number;
  order: number;
  selected: boolean;
  workspaceMode: WorkspaceMode;
  retry: RetryPolicy;
  verification: ProcessSpec[];
}

export interface WorkflowPlan {
  schemaVersion: 2;
  planId: string;
  createdAt: string;
  configFingerprint: string;
  selectedRoots: string[];
  includedTasks: string[];
  edges: WorkflowEdge[];
  levels: string[][];
  concurrencyGroups: string[][];
  order: string[];
  tasks: WorkflowPlanTask[];
  concurrency: number;
  failureMode: FailureMode;
  isolation: IsolationStrategy;
  retention: WorktreeRetention;
  dirtyBaseAcknowledged: boolean;
}

export type BatchTaskState =
  | "pending"
  | "ready"
  | "running"
  | "retry_wait"
  | "succeeded"
  | "failed"
  | "blocked"
  | "skipped"
  | "interrupted"
  | "incomplete";

export type BatchStatus =
  | "running"
  | "succeeded"
  | "succeeded_with_warnings"
  | "partially_failed"
  | "failed"
  | "interrupted"
  | "incomplete"
  | "abandoned";

export interface BatchAttemptReference {
  attempt: number;
  runId: string;
  manifest: string;
  report?: string;
  status: TaskStatus;
  outcome: TaskOutcome;
  score: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  retryEligible: boolean;
  retryReason?: string;
  retryDelayMs?: number;
  workspaceId?: string;
  resultRevision?: string;
  applicable?: boolean;
}

export interface BatchBlockReason {
  dependencyId: string;
  dependencyState: BatchTaskState;
  runId?: string;
  outcome?: TaskOutcome;
  chain: string[];
  message: string;
}

export interface BatchTaskRecord {
  id: string;
  name: string;
  file: string;
  dependencies: string[];
  workspaceMode: WorkspaceMode;
  retry: RetryPolicy;
  state: BatchTaskState;
  finalOutcome?: TaskOutcome;
  attempts: BatchAttemptReference[];
  finalAttempt?: number;
  blockReason?: BatchBlockReason;
  skipReason?: string;
  warnings: string[];
}

export interface BatchLifecycleEvent {
  stage: "created" | "planning" | "running" | "cancelling" | "persisting" | "completed";
  at: string;
  taskId?: string;
  detail?: string;
}

export interface BatchSummary {
  total: number;
  succeeded: number;
  failed: number;
  blocked: number;
  skipped: number;
  interrupted: number;
  incomplete: number;
  retried: number;
  score: number | null;
  status: BatchStatus;
  outcome: TaskOutcome;
}

export interface BatchRecord {
  schemaVersion: 1 | typeof CURRENT_BATCH_SCHEMA_VERSION;
  kind: "batch";
  runId: string;
  batchId: string;
  status: RunStatus;
  batchStatus: BatchStatus;
  outcome: TaskOutcome;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  durationMs?: number;
  ariadneVersion: string;
  environment: RunRecord["environment"];
  owner: RunOwner;
  project: RunRecord["project"];
  configPath?: string;
  configFingerprint?: string;
  sourceHead?: string;
  sourceDirty?: boolean;
  dirtyBaseAcknowledged?: boolean;
  excludedSourceChanges?: RepositoryEntry[];
  repositoryId?: string;
  plan?: WorkflowPlan;
  tasks: BatchTaskRecord[];
  lifecycle: BatchLifecycleEvent[];
  failures: FailureRecord[];
  warnings: string[];
  relation?: {
    kind: "resume" | "rerun";
    sourceBatchId: string;
  };
  summary: BatchSummary;
  artifacts: {
    manifest: string;
    report?: string;
  };
}

export interface BatchPaths {
  batchesDirectory: string;
  batchDirectory: string;
  manifestPath: string;
  relativeManifestPath: string;
  latestPointerPath: string;
  latestInvocationPath: string;
}

export interface WorkspaceRecord {
  schemaVersion: typeof CURRENT_WORKSPACE_SCHEMA_VERSION;
  workspaceId: string;
  runId: string;
  batchId: string;
  planId: string;
  taskId: string;
  attempt: number;
  repositoryId: string;
  sourceRevision: string;
  preparedRevision?: string;
  path: string;
  metadataPath: string;
  state: WorkspaceState;
  retention: WorktreeRetention;
  retentionReason?: string;
  createdAt: string;
  updatedAt: string;
  owner: RunOwner;
  lifecycle: Array<{ state: WorkspaceState; at: string; detail?: string }>;
  cleanupAt?: string;
  cleanupError?: string;
}

export type PromotionStatus = "validating" | "preflighting" | "applying" | "succeeded" | "conflicted" | "discarded" | "interrupted" | "failed";

export interface PromotionRecord {
  schemaVersion: typeof CURRENT_PROMOTION_SCHEMA_VERSION;
  promotionId: string;
  kind: "apply" | "discard";
  status: PromotionStatus;
  runId: string;
  includedRunIds: string[];
  repositoryId: string;
  targetBranch?: string;
  preApplyRevision?: string;
  postApplyRevision?: string;
  promotionCommit?: string;
  strategy?: "preflight-squash-cherry-pick";
  conflictPaths: string[];
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  owner: RunOwner;
  lifecycle: Array<{ status: PromotionStatus; at: string; detail?: string }>;
  cleanup?: { preflightPath?: string; removed?: boolean; error?: string };
  error?: string;
}
