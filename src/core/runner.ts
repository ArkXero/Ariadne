import crypto from "node:crypto";
import path from "node:path";
import { execa } from "execa";
import fs from "fs-extra";
import { atomicWriteFile } from "./atomic.js";
import { persistedCommand } from "./command-utils.js";
import { loadConfig } from "./config.js";
import { AriadneError, asAriadneError, safeValue } from "./errors.js";
import { findForbiddenProcessSpecMatches } from "./forbidden-commands.js";
import { diffForbiddenSnapshots, snapshotForbiddenFiles, type ForbiddenSnapshot } from "./forbidden-files.js";
import {
  captureRepositorySnapshot,
  combineTaskChanges,
  diffRepositorySnapshots,
  getGitDiff
} from "./git.js";
import {
  createRunId,
  createRunPaths,
  initialRunRecord,
  persistRun,
  summarizeOutcome,
  updateLatestPointer
} from "./persistence.js";
import { runProcess } from "./process-runner.js";
import { evaluatePolicies, scorePolicies } from "./scorer.js";
import { loadTasks } from "./task-loader.js";
import { getAriadneVersion } from "./version.js";
import type {
  AriadneConfig,
  AriadneTask,
  ChangeEvidence,
  FailureRecord,
  ForbiddenFileEvidence,
  LifecycleEvent,
  LifecycleStage,
  ObservedCommand,
  PersistedTask,
  ProcessResult,
  RepositorySnapshot,
  RepositoryTrace,
  RunPaths,
  RunRecord,
  TaskOutcome,
  TaskRunResult,
  VerificationResult
} from "../types/index.js";

export interface RunOptions {
  cwd: string;
  configPath?: string;
  taskIds?: string[];
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  now?: () => Date;
  randomId?: () => string;
}

function relative(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function failure(error: AriadneError, taskId?: string, projectRoot?: string): FailureRecord {
  const source = error.source && projectRoot && path.isAbsolute(error.source)
    ? (() => {
        const relativeSource = path.relative(projectRoot, error.source);
        return relativeSource === "" || (!relativeSource.startsWith("..") && !path.isAbsolute(relativeSource))
          ? relativeSource || "."
          : error.source;
      })()
    : error.source;
  const diagnostic = {
    ...(error.fieldPath ? { fieldPath: error.fieldPath } : {}),
    ...(error.offendingValue !== undefined ? { offendingValue: safeValue(error.offendingValue) } : {}),
    ...(error.expected ? { expected: error.expected } : {}),
    ...(error.correction ? { correction: error.correction } : {})
  };
  const details = { ...error.details, ...(Object.keys(diagnostic).length > 0 ? { diagnostic } : {}) };
  return {
    category: error.category,
    code: error.code,
    stage: error.stage,
    message: error.message,
    ...(source ? { source } : {}),
    ...(taskId ? { taskId } : {}),
    ...(Object.keys(details).length > 0 ? { details } : {})
  };
}

function taskEnvironment(task: AriadneTask, includePrompt: boolean): Record<string, string> {
  return {
    ARIADNE_TASK_ID: task.id,
    ARIADNE_TASK_NAME: task.name,
    ARIADNE_TASK_FILE: task.file,
    ...(includePrompt ? { ARIADNE_TASK_PROMPT: task.prompt } : {})
  };
}

function persistedTask(task: AriadneTask): PersistedTask {
  return {
    id: task.id,
    name: task.name,
    file: task.file,
    promptSha256: crypto.createHash("sha256").update(task.prompt).digest("hex"),
    promptLength: Buffer.byteLength(task.prompt),
    ...(task.metadata ? { metadata: task.metadata } : {})
  };
}

function sanitizeConfig(config: AriadneConfig): AriadneConfig {
  const sanitize = (spec: AriadneConfig["agent"]["command"]): AriadneConfig["agent"]["command"] => {
    const persisted = persistedCommand(spec);
    return spec.kind === "shell"
      ? { kind: "shell", command: persisted.displayCommand }
      : { kind: "exec", file: spec.file, args: persisted.args };
  };
  return {
    ...config,
    agent: { ...config.agent, command: sanitize(config.agent.command) },
    verification: { ...config.verification, commands: config.verification.commands.map(sanitize) }
  };
}

function lifecycle(stage: LifecycleStage, taskId?: string, detail?: string): LifecycleEvent {
  return { stage, at: new Date().toISOString(), ...(taskId ? { taskId } : {}), ...(detail ? { detail } : {}) };
}

async function checkpoint(record: RunRecord, paths: RunPaths, stage: LifecycleStage, detail?: string): Promise<void> {
  record.lifecycle.push(lifecycle(stage, undefined, detail));
  await persistRun(record, paths);
}

function reportedCommands(process: ProcessResult | undefined, source: ObservedCommand["source"]): ObservedCommand[] {
  if (!process) return [];
  const text = [process.stdoutPreview.head, process.stdoutPreview.tail, process.stderrPreview.head, process.stderrPreview.tail].join("\n");
  const pattern = /^(?:\s*[$>]\s*)?(?:npm|pnpm|yarn|bun|npx|node|git|rm|cp|mv|mkdir|touch|python|python3|pytest|make|go|cargo|docker|docker-compose)\b.+$/gm;
  return [...new Set([...text.matchAll(pattern)].map((match) => match[0].replace(/^\s*[$>]\s*/, "").trim()))]
    .sort()
    .map((representation) => ({ source, representation, confidence: "reported" }));
}

async function readWorkingText(projectRoot: string, filePath: string): Promise<string | null> {
  const absolute = path.join(projectRoot, filePath);
  const stat = await fs.lstat(absolute).catch(() => undefined);
  if (!stat) return null;
  if (stat.isSymbolicLink()) return `SYMLINK:${await fs.readlink(absolute).catch(() => "[unreadable]")}`;
  if (!stat.isFile() || stat.size > 1_000_000) return `BINARY_OR_LARGE:${stat.size}:${stat.mode}`;
  const contents = await fs.readFile(absolute).catch(() => undefined);
  if (!contents || contents.includes(0)) return `BINARY_OR_UNREADABLE:${stat.size}:${stat.mode}`;
  return contents.toString("utf8");
}

async function captureDirtyContents(projectRoot: string, snapshot: RepositorySnapshot): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  await Promise.all(snapshot.entries.map(async (entry) => result.set(entry.path, await readWorkingText(projectRoot, entry.path))));
  return result;
}

async function readHeadText(projectRoot: string, filePath: string): Promise<string | null> {
  const result = await execa("git", ["show", `HEAD:./${filePath}`], { cwd: projectRoot, reject: false, stripFinalNewline: false }).catch(() => undefined);
  return result?.exitCode === 0 ? result.stdout : null;
}

function changedLineCount(before: string | null, after: string | null): number {
  if (before === after) return 0;
  if (before?.startsWith("BINARY_") || after?.startsWith("BINARY_")) return 1;
  const beforeLines = before === null ? [] : before.split(/\r?\n/);
  const afterLines = after === null ? [] : after.split(/\r?\n/);
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix && suffix < afterLines.length - prefix
    && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) suffix += 1;
  return (beforeLines.length - prefix - suffix) + (afterLines.length - prefix - suffix);
}

async function countTaskDiffLines(
  projectRoot: string,
  baseline: RepositorySnapshot,
  baselineContents: Map<string, string | null>,
  changes: ChangeEvidence[]
): Promise<number> {
  const baselinePaths = new Set(baseline.entries.map((entry) => entry.path));
  let total = 0;
  for (const change of changes) {
    const before = baselinePaths.has(change.path)
      ? baselineContents.get(change.path) ?? null
      : baseline.available ? await readHeadText(projectRoot, change.originalPath ?? change.path) : null;
    const after = await readWorkingText(projectRoot, change.path);
    total += changedLineCount(before, after);
  }
  return total;
}

function combineForbidden(agent: ForbiddenFileEvidence[], verification: ForbiddenFileEvidence[]): ForbiddenFileEvidence[] {
  const map = new Map<string, ForbiddenFileEvidence>();
  for (const change of agent) map.set(`${change.rule}\0${change.path}`, change);
  for (const change of verification) {
    const key = `${change.rule}\0${change.path}`;
    const existing = map.get(key);
    map.set(key, existing ? { ...change, source: "agent-and-verification", baselineFingerprint: existing.baselineFingerprint } : change);
  }
  return [...map.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function emptyTrace(snapshot: RepositorySnapshot, observedCommands: ObservedCommand[]): RepositoryTrace {
  return {
    baseline: snapshot,
    postAgent: snapshot,
    final: snapshot,
    preexistingChanges: snapshot.entries,
    agentChanges: [],
    verificationChanges: [],
    taskChanges: [],
    forbiddenFileChanges: [],
    diffLineCount: 0,
    observedCommands
  };
}

function skippedVerification(config: AriadneConfig, reason: string): VerificationResult[] {
  return config.verification.commands.map((spec) => ({
    displayCommand: persistedCommand(spec).displayCommand,
    status: "skipped" as const,
    skipReason: reason
  }));
}

async function runTask(options: {
  projectRoot: string;
  runDirectory: string;
  config: AriadneConfig;
  task: AriadneTask;
  signal?: AbortSignal;
}): Promise<TaskRunResult> {
  const started = new Date();
  const taskLifecycle: LifecycleEvent[] = [lifecycle("preparing", options.task.id)];
  const failures: FailureRecord[] = [];
  let agent: ProcessResult | undefined;
  let verification: VerificationResult[] = [];
  let trace: RepositoryTrace | undefined;
  let baseline: RepositorySnapshot;
  let postAgent: RepositorySnapshot;
  let final: RepositorySnapshot;
  let forbiddenBaseline: ForbiddenSnapshot;
  let forbiddenPostAgent: ForbiddenSnapshot;
  let forbiddenFinal: ForbiddenSnapshot;
  const internalArtifactPrefix = relative(options.projectRoot, options.runDirectory);

  try {
    baseline = await captureRepositorySnapshot(options.projectRoot, [internalArtifactPrefix]);
    forbiddenBaseline = await snapshotForbiddenFiles(options.projectRoot, options.config.checks.forbidden_files);
    const baselineContents = await captureDirtyContents(options.projectRoot, baseline);
    const agentDisplay = persistedCommand(options.config.agent.command).displayCommand;
    const blockedAgent = findForbiddenProcessSpecMatches(options.config.checks.forbidden_commands, options.config.agent.command);
    const observed: ObservedCommand[] = [];

    if (blockedAgent.length > 0) {
      observed.push({ source: "agent-config", representation: agentDisplay, confidence: "blocked" });
      trace = emptyTrace(baseline, observed);
      const policies = evaluatePolicies(trace, options.config);
      failures.push({
        category: "policy_violation",
        code: "FORBIDDEN_AGENT_COMMAND",
        stage: "evaluating_policy",
        message: "Agent command was blocked because it matched a forbidden command rule.",
        taskId: options.task.id,
        details: { matches: blockedAgent.map((match) => ({ ...match, command: agentDisplay })) }
      });
      const completed = new Date();
      return {
        task: persistedTask(options.task),
        status: "failed",
        outcome: "policy_failed",
        startedAt: started.toISOString(),
        completedAt: completed.toISOString(),
        durationMs: completed.getTime() - started.getTime(),
        lifecycle: [...taskLifecycle, lifecycle("evaluating_policy", options.task.id), lifecycle("scoring", options.task.id), lifecycle("completed", options.task.id)],
        verification: skippedVerification(options.config, "Agent command was blocked by policy."),
        trace,
        policies,
        score: scorePolicies(policies),
        failures
      };
    }

    taskLifecycle.push(lifecycle("agent_running", options.task.id));
    const taskArtifacts = path.join(options.runDirectory, "artifacts", options.task.id);
    agent = await runProcess({
      spec: options.config.agent.command,
      projectRoot: options.projectRoot,
      stdoutPath: path.join(taskArtifacts, "agent.stdout.log"),
      stderrPath: path.join(taskArtifacts, "agent.stderr.log"),
      input: options.task.prompt,
      timeoutMs: options.config.agent.timeout_ms,
      terminationGraceMs: options.config.execution.termination_grace_ms,
      env: taskEnvironment(options.task, true),
      signal: options.signal
    });
    taskLifecycle.push(lifecycle("agent_finished", options.task.id));
    observed.push({ source: "agent-config", representation: agentDisplay, confidence: "executed" }, ...reportedCommands(agent, "agent-output"));
    postAgent = await captureRepositorySnapshot(options.projectRoot, [internalArtifactPrefix]);
    forbiddenPostAgent = await snapshotForbiddenFiles(options.projectRoot, options.config.checks.forbidden_files);

    const cleanupSucceeded = !agent.cleanup.attempted || (agent.cleanup.forceSignal
      ? agent.cleanup.forceSucceeded === true
      : agent.cleanup.gracefulSucceeded === true);
    if (agent.interrupted || options.signal?.aborted) {
      verification = skippedVerification(options.config, "Run was interrupted; no new processes were launched.");
    } else if (agent.spawnError) {
      verification = skippedVerification(options.config, "Agent process could not be spawned.");
    } else if (agent.timedOut && !cleanupSucceeded) {
      verification = skippedVerification(options.config, "Timed-out agent cleanup could not be confirmed.");
    } else {
      taskLifecycle.push(lifecycle("verifying", options.task.id));
      for (const [index, spec] of options.config.verification.commands.entries()) {
        const displayCommand = persistedCommand(spec).displayCommand;
        const blocked = findForbiddenProcessSpecMatches(options.config.checks.forbidden_commands, spec);
        if (blocked.length > 0) {
          observed.push({ source: "verification-config", representation: displayCommand, confidence: "blocked" });
          verification.push({ displayCommand, status: "skipped", skipReason: "Verification command matched a forbidden command rule." });
          failures.push({
            category: "policy_violation",
            code: "FORBIDDEN_VERIFICATION_COMMAND",
            stage: "verifying",
            message: `Verification command ${index + 1} was blocked by policy.`,
            taskId: options.task.id,
            details: { matches: blocked.map((match) => ({ ...match, command: displayCommand })) }
          });
          continue;
        }

        const processResult = await runProcess({
          spec,
          projectRoot: options.projectRoot,
          stdoutPath: path.join(taskArtifacts, `verification-${index + 1}.stdout.log`),
          stderrPath: path.join(taskArtifacts, `verification-${index + 1}.stderr.log`),
          timeoutMs: options.config.verification.timeout_ms,
          terminationGraceMs: options.config.execution.termination_grace_ms,
          env: taskEnvironment(options.task, false),
          signal: options.signal
        });
        observed.push({ source: "verification-config", representation: displayCommand, confidence: "executed" }, ...reportedCommands(processResult, "verification-output"));
        verification.push({
          displayCommand,
          command: processResult,
          status: processResult.exitCode === 0 && !processResult.timedOut && !processResult.interrupted && !processResult.spawnError ? "passed" : "failed"
        });
        if (processResult.interrupted || options.signal?.aborted) break;
      }
    }

    taskLifecycle.push(lifecycle("collecting_trace", options.task.id));
    final = await captureRepositorySnapshot(options.projectRoot, [internalArtifactPrefix]);
    forbiddenFinal = await snapshotForbiddenFiles(options.projectRoot, options.config.checks.forbidden_files);
    const agentChanges = diffRepositorySnapshots(baseline, postAgent, "agent");
    const verificationChanges = diffRepositorySnapshots(postAgent, final, "verification");
    const taskChanges = combineTaskChanges(agentChanges, verificationChanges);
    const agentForbidden = diffForbiddenSnapshots(forbiddenBaseline, forbiddenPostAgent, "agent");
    const verificationForbidden = diffForbiddenSnapshots(forbiddenPostAgent, forbiddenFinal, "verification");
    const finalDiff = await getGitDiff(options.projectRoot, [internalArtifactPrefix]);
    const diffPath = path.join(taskArtifacts, "repository.diff");
    await atomicWriteFile(diffPath, finalDiff);
    trace = {
      baseline,
      postAgent,
      final,
      preexistingChanges: baseline.entries,
      agentChanges,
      verificationChanges,
      taskChanges,
      forbiddenFileChanges: combineForbidden(agentForbidden, verificationForbidden),
      diffArtifact: relative(options.projectRoot, diffPath),
      diffLineCount: await countTaskDiffLines(options.projectRoot, baseline, baselineContents, taskChanges),
      observedCommands: observed
    };

    taskLifecycle.push(lifecycle("evaluating_policy", options.task.id));
    const policies = evaluatePolicies(trace, options.config);
    taskLifecycle.push(lifecycle("scoring", options.task.id));
    const score = scorePolicies(policies);

    const verificationInterrupted = verification.some((result) => result.command?.interrupted);
    if (agent.interrupted || verificationInterrupted) {
      failures.push({ category: "user_interruption", code: "RUN_INTERRUPTED", stage: verificationInterrupted ? "verifying" : "agent_running", message: "Task execution was interrupted.", taskId: options.task.id });
    } else if (agent.spawnError) {
      failures.push({ category: "agent_spawn", code: "AGENT_SPAWN_FAILED", stage: "agent_running", message: agent.spawnError, taskId: options.task.id });
    } else if (agent.timedOut) {
      failures.push({ category: "agent_timeout", code: "AGENT_TIMEOUT", stage: "agent_running", message: `Agent timed out after ${options.config.agent.timeout_ms}ms.`, taskId: options.task.id });
    } else if (agent.exitCode !== 0) {
      failures.push({ category: "agent_nonzero", code: "AGENT_NONZERO", stage: "agent_finished", message: `Agent exited with code ${agent.exitCode}.`, taskId: options.task.id });
    }
    for (const result of verification) {
      if (!result.command || result.status !== "failed" || result.command.interrupted) continue;
      failures.push({
        category: result.command.spawnError ? "verification_spawn" : "verification_nonzero",
        code: result.command.spawnError ? "VERIFICATION_SPAWN_FAILED" : result.command.timedOut ? "VERIFICATION_TIMEOUT" : "VERIFICATION_NONZERO",
        stage: "verifying",
        message: result.command.spawnError
          ?? (result.command.timedOut
            ? `Verification command timed out after ${options.config.verification.timeout_ms}ms.`
            : `Verification command exited with code ${result.command.exitCode}.`),
        taskId: options.task.id,
        details: { command: result.displayCommand }
      });
    }
    if (policies.some((policy) => policy.outcome === "fail")) {
      failures.push({ category: "policy_violation", code: "POLICY_FAILED", stage: "evaluating_policy", message: "One or more policy rules failed.", taskId: options.task.id });
    }

    let outcome: TaskOutcome = "passed";
    if (agent.interrupted || verification.some((result) => result.command?.interrupted)) outcome = "interrupted";
    else if (agent.timedOut || verification.some((result) => result.command?.timedOut)) outcome = "timeout";
    else if (agent.spawnError || agent.exitCode !== 0) outcome = "agent_failed";
    else if (verification.some((result) => result.status === "failed")) outcome = "verification_failed";
    else if (policies.some((policy) => policy.outcome === "fail")) outcome = "policy_failed";

    const completed = new Date();
    taskLifecycle.push(lifecycle("completed", options.task.id));
    return {
      task: persistedTask(options.task),
      status: outcome === "passed" ? "passed" : outcome === "interrupted" ? "interrupted" : "failed",
      outcome,
      startedAt: started.toISOString(),
      completedAt: completed.toISOString(),
      durationMs: completed.getTime() - started.getTime(),
      lifecycle: taskLifecycle,
      agent,
      verification,
      trace,
      policies,
      score,
      failures
    };
  } catch (error) {
    const ariadneError = asAriadneError(error, { category: "internal", code: "TASK_INTERNAL_ERROR", stage: "collecting_trace" });
    const completed = new Date();
    return {
      task: persistedTask(options.task),
      status: options.signal?.aborted ? "interrupted" : "failed",
      outcome: options.signal?.aborted ? "interrupted" : "internal_failed",
      startedAt: started.toISOString(),
      completedAt: completed.toISOString(),
      durationMs: completed.getTime() - started.getTime(),
      lifecycle: [...taskLifecycle, lifecycle("completed", options.task.id, "Task ended after an internal failure.")],
      ...(agent ? { agent } : {}),
      verification,
      ...(trace ? { trace } : {}),
      policies: [],
      score: scorePolicies([]),
      failures: [...failures, failure(ariadneError, options.task.id, options.projectRoot)]
    };
  }
}

function selectTasks(tasks: AriadneTask[], taskIds: string[] | undefined): AriadneTask[] {
  if (!taskIds || taskIds.length === 0) return tasks;
  const requested = [...new Set(taskIds.map((id) => id.toLowerCase()))];
  const selected = tasks.filter((task) => requested.includes(task.id.toLowerCase()));
  const missing = requested.filter((id) => !tasks.some((task) => task.id.toLowerCase() === id));
  if (missing.length > 0) {
    throw new AriadneError({
      category: "task_selection",
      code: "TASK_NOT_FOUND",
      stage: "validated",
      message: `Task selection did not match: ${missing.join(", ")}.`,
      correction: `Choose one of: ${tasks.map((task) => task.id).join(", ")}.`,
      details: { requested: taskIds, available: tasks.map((task) => task.id) }
    });
  }
  return selected;
}

async function finalizeRun(record: RunRecord, paths: RunPaths, startedAt: Date): Promise<void> {
  if (record.status !== "running") {
    await persistRun(record, paths);
    await updateLatestPointer(record, paths);
    return;
  }
  const outcomes = record.results.map((result) => result.outcome);
  const outcome = summarizeOutcome(outcomes.length > 0 ? outcomes : record.failures.length > 0 ? ["internal_failed"] : ["passed"]);
  const completed = new Date();
  record.completedAt = completed.toISOString();
  record.durationMs = completed.getTime() - startedAt.getTime();
  record.status = outcome === "interrupted" ? "interrupted" : outcome === "passed" ? "completed" : "failed";
  record.summary = {
    total: record.results.length,
    passed: record.results.filter((result) => result.outcome === "passed").length,
    failed: record.results.filter((result) => result.outcome !== "passed" && result.outcome !== "interrupted").length,
    interrupted: record.results.filter((result) => result.outcome === "interrupted").length,
    status: record.status,
    outcome
  };
  record.failures = [...record.failures, ...record.results.flatMap((result) => result.failures)];
  record.lifecycle.push(lifecycle("persisting"), lifecycle("completed"));
  await persistRun(record, paths);
  await updateLatestPointer(record, paths);
}

export async function runAriadne(options: RunOptions): Promise<RunRecord & { outputPath: string }> {
  const invocationRoot = await fs.realpath(options.cwd).catch(() => path.resolve(options.cwd));
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const runId = createRunId(startedAt, options.randomId?.());
  const paths = await createRunPaths(invocationRoot, runId);
  const record = initialRunRecord({ runId, startedAt, ariadneVersion: await getAriadneVersion(), paths });
  await persistRun(record, paths);

  try {
    await checkpoint(record, paths, "loading");
    const loaded = await loadConfig(invocationRoot, options.configPath);
    record.project.configPath = relative(loaded.projectRoot, loaded.path);
    record.config = sanitizeConfig(loaded.config);
    record.compatibilityWarnings = loaded.warnings;
    const allTasks = await loadTasks(loaded.projectRoot, loaded.config.tasks.directory);
    const tasks = selectTasks(allTasks, options.taskIds);
    const repository = await captureRepositorySnapshot(loaded.projectRoot);
    if (!repository.available && (loaded.config.checks.max_changed_files !== undefined || loaded.config.checks.max_diff_lines !== undefined)) {
      throw new AriadneError({
        category: "repository_validation",
        code: "GIT_REQUIRED_FOR_POLICIES",
        stage: "validated",
        message: "Git repository state is unavailable, but changed-file or diff-line policies are configured.",
        correction: "Run inside a Git repository or remove Git-dependent limits.",
        details: { reason: repository.unavailableReason }
      });
    }
    record.project.repository = { head: repository.head, branch: repository.branch, detached: repository.detached };
    await checkpoint(record, paths, "validated", `Loaded ${tasks.length} task(s).`);

    for (const task of tasks) {
      if (options.signal?.aborted) break;
      options.onProgress?.(`Running task: ${task.id}`);
      await checkpoint(record, paths, "preparing", `Preparing task ${task.id}.`);
      const result = await runTask({
        projectRoot: loaded.projectRoot,
        runDirectory: paths.runDirectory,
        config: loaded.config,
        task,
        signal: options.signal
      });
      record.results.push(result);
      await persistRun(record, paths);
      if (result.outcome === "interrupted" || result.outcome === "internal_failed") break;
    }
  } catch (error) {
    const ariadneError = asAriadneError(error, { category: "internal", code: "RUN_INTERNAL_ERROR", stage: "loading" });
    record.failures.push(failure(ariadneError, undefined, invocationRoot));
  }

  await finalizeRun(record, paths, startedAt);
  return { ...record, outputPath: paths.manifestPath };
}
