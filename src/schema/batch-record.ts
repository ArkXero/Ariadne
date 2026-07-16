import { z } from "zod";
import { FailureSchema } from "./task-result.js";
import { CURRENT_BATCH_SCHEMA_VERSION } from "../types/index.js";

const RetrySchema = z.object({ attempts: z.number().int().min(1).max(10), delayMs: z.number().int().min(0).max(3_600_000), backoff: z.enum(["fixed", "exponential"]) }).strict();
const ProcessSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exec"), file: z.string(), args: z.array(z.string()) }).strict(),
  z.object({ kind: z.literal("shell"), command: z.string() }).strict()
]);
const TaskStateSchema = z.enum(["pending", "ready", "running", "retry_wait", "succeeded", "failed", "blocked", "skipped", "interrupted", "incomplete"]);
const RunStatusSchema = z.enum(["running", "completed", "failed", "interrupted", "incomplete", "abandoned"]);
const BatchStatusSchema = z.enum(["running", "succeeded", "succeeded_with_warnings", "partially_failed", "failed", "interrupted", "incomplete", "abandoned"]);
const TaskOutcomeSchema = z.enum(["passed", "preparation_failed", "agent_failed", "verification_failed", "policy_failed", "timeout", "interrupted", "internal_failed"]);

const PlanTaskSchema = z.object({
  id: z.string(), name: z.string(), file: z.string(), dependencies: z.array(z.string()), level: z.number().int().nonnegative(),
  order: z.number().int().nonnegative(), selected: z.boolean(), workspaceMode: z.enum(["mutable", "read-only"]), retry: RetrySchema,
  verification: z.array(ProcessSpecSchema)
}).strict();

export const WorkflowPlanSchema = z.object({
  schemaVersion: z.literal(2), planId: z.string(), createdAt: z.string().datetime(), configFingerprint: z.string(),
  selectedRoots: z.array(z.string()), includedTasks: z.array(z.string()),
  edges: z.array(z.object({ from: z.string(), to: z.string() }).strict()), levels: z.array(z.array(z.string())),
  concurrencyGroups: z.array(z.array(z.string())), order: z.array(z.string()), tasks: z.array(PlanTaskSchema), concurrency: z.number().int().min(1).max(32),
  failureMode: z.enum(["continue", "fail-fast"]), isolation: z.enum(["shared", "worktree"]),
  retention: z.enum(["always", "on-failure", "never"]), dirtyBaseAcknowledged: z.boolean()
}).strict();

const AttemptSchema = z.object({
  attempt: z.number().int().positive(), runId: z.string(), manifest: z.string(), report: z.string().optional(),
  status: z.enum(["running", "passed", "failed", "interrupted", "incomplete"]), outcome: TaskOutcomeSchema,
  score: z.number().min(0).max(100), startedAt: z.string().datetime(), completedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(), retryEligible: z.boolean(), retryReason: z.string().optional(), retryDelayMs: z.number().int().nonnegative().optional(),
  workspaceId: z.string().optional(), resultRevision: z.string().optional(), applicable: z.boolean().optional()
}).strict();

const BatchTaskSchema = z.object({
  id: z.string(), name: z.string(), file: z.string(), dependencies: z.array(z.string()), workspaceMode: z.enum(["mutable", "read-only"]), retry: RetrySchema,
  state: TaskStateSchema, finalOutcome: TaskOutcomeSchema.optional(), attempts: z.array(AttemptSchema), finalAttempt: z.number().int().positive().optional(),
  blockReason: z.object({ dependencyId: z.string(), dependencyState: TaskStateSchema, runId: z.string().optional(), outcome: TaskOutcomeSchema.optional(), chain: z.array(z.string()), message: z.string() }).strict().optional(),
  skipReason: z.string().optional(), warnings: z.array(z.string())
}).strict();

export const BatchRecordSchema = z.object({
  schemaVersion: z.literal(CURRENT_BATCH_SCHEMA_VERSION), kind: z.literal("batch"), runId: z.string(), batchId: z.string(), status: RunStatusSchema,
  batchStatus: BatchStatusSchema, outcome: TaskOutcomeSchema,
  startedAt: z.string().datetime(), updatedAt: z.string().datetime(), completedAt: z.string().datetime().optional(), durationMs: z.number().int().nonnegative().optional(),
  ariadneVersion: z.string(), environment: z.object({ node: z.string(), platform: z.string(), release: z.string(), arch: z.string() }).strict(),
  owner: z.object({ pid: z.number().int().positive(), hostname: z.string(), startedAt: z.string().datetime() }).strict(),
  project: z.object({ root: z.literal("."), configPath: z.string().optional(), repository: z.object({ head: z.string().optional(), branch: z.string().optional(), detached: z.boolean().optional() }).strict().optional() }).strict(),
  configPath: z.string().optional(), configFingerprint: z.string().optional(), sourceHead: z.string().optional(), sourceDirty: z.boolean().optional(),
  dirtyBaseAcknowledged: z.boolean().optional(), excludedSourceChanges: z.array(z.object({
    path: z.string(), originalPath: z.string().optional(), indexStatus: z.string(), worktreeStatus: z.string(),
    changeType: z.enum(["added", "modified", "deleted", "renamed", "copied", "mode-changed", "symlink-changed", "untracked", "ignored"]),
    kind: z.enum(["file", "symlink", "other"]).optional(), mode: z.string().optional(), fingerprint: z.string().optional()
  }).strict()).optional(), repositoryId: z.string().optional(), plan: WorkflowPlanSchema.optional(),
  tasks: z.array(BatchTaskSchema), lifecycle: z.array(z.object({ stage: z.enum(["created", "planning", "running", "cancelling", "persisting", "completed"]), at: z.string().datetime(), taskId: z.string().optional(), detail: z.string().optional() }).strict()),
  failures: z.array(FailureSchema), warnings: z.array(z.string()),
  relation: z.object({ kind: z.enum(["resume", "rerun"]), sourceBatchId: z.string() }).strict().optional(),
  summary: z.object({ total: z.number().int().nonnegative(), succeeded: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), blocked: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(), interrupted: z.number().int().nonnegative(), incomplete: z.number().int().nonnegative(), retried: z.number().int().nonnegative(), score: z.number().min(0).max(100).nullable(), status: BatchStatusSchema, outcome: TaskOutcomeSchema }).strict(),
  artifacts: z.object({ manifest: z.string(), report: z.string().optional() }).strict()
}).strict().superRefine((record, context) => {
  if (record.runId !== record.batchId) context.addIssue({ code: "custom", path: ["runId"], message: "runId must equal batchId." });
  const compatibleStatus = record.batchStatus === "running" ? "running"
    : record.batchStatus === "succeeded" || record.batchStatus === "succeeded_with_warnings" ? "completed"
      : record.batchStatus === "interrupted" ? "interrupted"
        : record.batchStatus === "incomplete" ? "incomplete"
          : record.batchStatus === "abandoned" ? "abandoned" : "failed";
  if (record.status !== compatibleStatus) context.addIssue({ code: "custom", path: ["status"], message: "status must be the compatible run status derived from batchStatus." });
  if (record.outcome !== record.summary.outcome) context.addIssue({ code: "custom", path: ["outcome"], message: "outcome must equal summary.outcome." });
  if (record.summary.status !== record.batchStatus) context.addIssue({ code: "custom", path: ["summary", "status"], message: "summary.status must equal batchStatus." });
  if (record.plan && record.configFingerprint !== record.plan.configFingerprint) context.addIssue({ code: "custom", path: ["configFingerprint"], message: "configFingerprint must equal plan.configFingerprint." });
});
