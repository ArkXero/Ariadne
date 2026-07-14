export const CURRENT_CONFIG_VERSION = 2 as const;
export const CURRENT_RUN_SCHEMA_VERSION = 2 as const;

export type LegacyConfigVersion = "versionless" | 1;

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
}

export type LifecycleStage =
  | "created"
  | "loading"
  | "validated"
  | "preparing"
  | "agent_running"
  | "agent_finished"
  | "verifying"
  | "collecting_trace"
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
  source: "agent" | "verification" | "agent-and-verification";
  baselineFingerprint?: string;
  finalFingerprint?: string;
}

export interface ForbiddenFileEvidence extends ChangeEvidence {
  rule: string;
  baselineState?: { fingerprint: string; kind: "file" | "symlink" | "other"; mode: string };
  finalState?: { fingerprint: string; kind: "file" | "symlink" | "other"; mode: string };
}

export interface ObservedCommand {
  source: "agent-config" | "verification-config" | "agent-output" | "verification-output";
  representation: string;
  confidence: "executed" | "reported" | "blocked";
}

export interface RepositoryTrace {
  baseline: RepositorySnapshot;
  postAgent: RepositorySnapshot;
  final: RepositorySnapshot;
  preexistingChanges: RepositoryEntry[];
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
  ruleId: "files.forbidden" | "commands.forbidden" | "changes.max-files" | "changes.max-diff-lines";
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

export type TaskOutcome = "passed" | "agent_failed" | "verification_failed" | "policy_failed" | "timeout" | "interrupted" | "internal_failed";

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
  schemaVersion: typeof CURRENT_RUN_SCHEMA_VERSION;
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
