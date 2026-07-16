import { z } from "zod";
import { FailureSchema, LifecycleEventSchema, TaskRunResultSchema } from "./task-result.js";
import { CURRENT_CONFIG_VERSION, CURRENT_RUN_SCHEMA_VERSION } from "../types/index.js";

const ProcessSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exec"), file: z.string(), args: z.array(z.string()) }).strict(),
  z.object({ kind: z.literal("shell"), command: z.string() }).strict()
]);

export const AriadneConfigSchema = z.object({
  version: z.literal(CURRENT_CONFIG_VERSION),
  sourceVersion: z.union([z.literal("versionless"), z.literal(1), z.literal(2), z.literal(3), z.literal(CURRENT_CONFIG_VERSION)]),
  agent: z.object({ command: ProcessSpecSchema, timeout_ms: z.number().int().positive() }).strict(),
  tasks: z.object({ directory: z.string() }).strict(),
  verification: z.object({ commands: z.array(ProcessSpecSchema), timeout_ms: z.number().int().positive() }).strict(),
  execution: z.object({
    termination_grace_ms: z.number().int().positive(),
    concurrency: z.number().int().min(1).max(32),
    failure_mode: z.enum(["continue", "fail-fast"]),
    isolation: z.enum(["shared", "worktree"]),
    worktree: z.object({
      retention: z.enum(["always", "on-failure", "never"]),
      preparation: z.object({ commands: z.array(ProcessSpecSchema), timeout_ms: z.number().int().positive() }).strict()
    }).strict()
  }).strict(),
  checks: z.object({
    forbidden_files: z.array(z.string()),
    max_changed_files: z.number().int().nonnegative().optional(),
    max_diff_lines: z.number().int().nonnegative().optional(),
    forbidden_commands: z.array(z.string())
  }).strict()
}).strict();

export const RunRecordSchema = z.object({
  schemaVersion: z.literal(CURRENT_RUN_SCHEMA_VERSION),
  runId: z.string(),
  status: z.enum(["running", "completed", "failed", "interrupted", "incomplete", "abandoned"]),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  ariadneVersion: z.string(),
  environment: z.object({ node: z.string(), platform: z.string(), release: z.string(), arch: z.string() }).strict(),
  owner: z.object({ pid: z.number().int().positive(), hostname: z.string(), startedAt: z.string().datetime() }).strict(),
  project: z.object({
    root: z.literal("."),
    configPath: z.string().optional(),
    repository: z.object({ head: z.string().optional(), branch: z.string().optional(), detached: z.boolean().optional() }).strict().optional()
  }).strict(),
  config: AriadneConfigSchema.optional(),
  compatibilityWarnings: z.array(z.string()),
  lifecycle: z.array(LifecycleEventSchema),
  results: z.array(TaskRunResultSchema),
  summary: z.object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    interrupted: z.number().int().nonnegative(),
    status: z.enum(["running", "completed", "failed", "interrupted", "incomplete", "abandoned"]),
    outcome: z.enum(["passed", "preparation_failed", "agent_failed", "verification_failed", "policy_failed", "timeout", "interrupted", "internal_failed"])
  }).strict(),
  failures: z.array(FailureSchema),
  artifacts: z.object({ manifest: z.string(), report: z.string().optional() }).strict(),
  workflow: z.object({
    batchId: z.string(),
    planId: z.string(),
    taskId: z.string(),
    attempt: z.number().int().positive()
  }).strict().optional(),
  workspace: z.object({
    workspaceId: z.string(), strategy: z.enum(["shared", "worktree"]), workspacePath: z.string().optional(), metadataPath: z.string().optional(),
    sourceRevision: z.string().optional(), preparedRevision: z.string().optional(), sourceDirty: z.boolean(), dirtyBaseAcknowledged: z.boolean(),
    excludedSourceChanges: z.array(z.object({
      path: z.string(), originalPath: z.string().optional(), indexStatus: z.string(), worktreeStatus: z.string(),
      changeType: z.enum(["added", "modified", "deleted", "renamed", "copied", "mode-changed", "symlink-changed", "untracked", "ignored"]),
      kind: z.enum(["file", "symlink", "other"]).optional(), mode: z.string().optional(), fingerprint: z.string().optional()
    }).strict()),
    repositoryId: z.string().optional(),
    state: z.enum(["creating", "ready", "preparing", "running", "capturing", "retained", "removing", "removed", "stale", "failed"]),
    retention: z.enum(["always", "on-failure", "never"]), retentionReason: z.string().optional(), cleanupAt: z.string().optional(), cleanupError: z.string().optional(),
    inheritedResults: z.array(z.object({ taskId: z.string(), runId: z.string(), resultRevision: z.string() }).strict()),
    preparation: z.array(TaskRunResultSchema.shape.agent.unwrap())
  }).strict().optional(),
  changeArtifact: z.object({
    schemaVersion: z.literal(1), state: z.enum(["captured", "empty", "incomplete"]), sourceRevision: z.string(), preparedRevision: z.string(),
    resultRevision: z.string().optional(), resultRef: z.string().optional(), patchArtifact: z.string().optional(), previewArtifact: z.string().optional(), manifestArtifact: z.string(),
    changes: z.array(z.object({ path: z.string(), originalPath: z.string().optional(), changeType: z.enum(["added", "modified", "deleted", "renamed", "copied", "mode-changed", "symlink-changed", "untracked", "ignored"]), additions: z.number().int().nonnegative().nullable(), deletions: z.number().int().nonnegative().nullable(), binary: z.boolean(), mode: z.string().optional(), kind: z.enum(["file", "symlink", "other"]).optional() }).strict()),
    omittedSensitive: z.array(z.object({ path: z.string(), reason: z.string(), rule: z.string().optional(), kind: z.enum(["file", "symlink", "other"]).optional(), size: z.number().int().nonnegative().optional(), sha256: z.string().optional() }).strict()),
    applicable: z.boolean(), ineligibleReason: z.string().optional()
  }).strict().optional()
}).strict();

export const AriadneRunSchema = RunRecordSchema;
export { CURRENT_RUN_SCHEMA_VERSION };

export function getRunSchemaVersion(run: { schemaVersion?: number; version?: number }): number {
  return run.schemaVersion ?? run.version ?? 1;
}

export type RunRecordType = z.infer<typeof RunRecordSchema>;
