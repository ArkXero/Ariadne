export interface AriadneConfig {
  version: number;
  agent: {
    command: string;
    timeout_ms: number;
  };
  tasks: {
    directory: string;
  };
  verification: {
    commands: string[];
    timeout_ms: number;
  };
  checks: {
    forbidden_files: string[];
    max_changed_files?: number;
    max_diff_lines?: number;
    forbidden_commands: string[];
  };
}

export interface AriadneTask {
  id: string;
  name: string;
  file: string;
  prompt: string;
  metadata?: Record<string, unknown>;
}

export interface CommandExecution {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  runtimeMs: number;
  startedAt: string;
  completedAt: string;
  timedOut: boolean;
}

export interface ScoreCheck {
  name: string;
  passed: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface TaskRunResult {
  task: AriadneTask;
  agent: CommandExecution;
  verification: CommandExecution[];
  trace: {
    gitAvailable: boolean;
    workspaceDirtyBefore: string[];
    changedFiles: string[];
    forbiddenFileChanges: string[];
    diff: string;
    diffLineCount: number;
    commandsObserved: string[];
  };
  score: {
    passed: boolean;
    checks: ScoreCheck[];
  };
}

export interface AriadneRun {
  version: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  cwd: string;
  configPath: string;
  config: AriadneConfig;
  results: TaskRunResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
  };
}
