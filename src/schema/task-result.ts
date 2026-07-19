import { z } from "zod";
import { TraceSchema } from "./trace.js";
import { CURRENT_RUN_SCHEMA_VERSION } from "../types/index.js";
import { BenchmarkResultSchema } from "./benchmark.js";
import { ProcessResultSchema } from "./process-result.js";

const LifecycleStageSchema = z.enum([
  "created", "loading", "validated", "workspace_creating", "workspace_ready", "preparing", "agent_running", "agent_finished",
  "verifying", "collecting_trace", "capturing_changes", "workspace_cleanup", "evaluating_policy", "scoring", "benchmark_packet", "judging", "benchmark_scoring", "persisting", "completed"
]);

const LifecycleEventSchema = z.object({
  stage: LifecycleStageSchema,
  at: z.string().datetime(),
  taskId: z.string().optional(),
  detail: z.string().optional()
}).strict();

const PolicyResultSchema = z.object({
  ruleId: z.enum(["files.forbidden", "commands.forbidden", "changes.max-files", "changes.max-diff-lines", "workspace.read-only"]),
  outcome: z.enum(["pass", "fail", "warning", "not-applicable"]),
  penalty: z.number().nonnegative(),
  summary: z.string(),
  evidence: z.record(z.string(), z.unknown())
}).strict();

const FailureSchema = z.object({
  category: z.enum([
    "configuration", "task_loading", "task_selection", "repository_validation", "workspace_preparation", "workspace_management", "promotion_conflict", "agent_spawn",
    "agent_nonzero", "agent_timeout", "verification_spawn", "verification_nonzero", "trace_collection",
    "policy_violation", "benchmark_protocol", "persistence", "user_interruption", "internal"
  ]),
  code: z.string(),
  stage: LifecycleStageSchema,
  message: z.string(),
  source: z.string().optional(),
  taskId: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional()
}).strict();

export const TaskRunResultSchema = z.object({
  task: z.object({
    id: z.string(),
    name: z.string(),
    file: z.string(),
    promptSha256: z.string(),
    promptLength: z.number().int().nonnegative(),
    metadata: z.record(z.string(), z.unknown()).optional()
  }).strict(),
  status: z.enum(["running", "passed", "failed", "interrupted", "incomplete"]),
  outcome: z.enum(["passed", "preparation_failed", "agent_failed", "verification_failed", "policy_failed", "timeout", "interrupted", "internal_failed"]),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
  lifecycle: z.array(LifecycleEventSchema),
  agent: ProcessResultSchema.optional(),
  verification: z.array(z.object({
    displayCommand: z.string(),
    command: ProcessResultSchema.optional(),
    status: z.enum(["passed", "failed", "skipped"]),
    skipReason: z.string().optional()
  }).strict()),
  trace: TraceSchema.optional(),
  policies: z.array(PolicyResultSchema),
  score: z.object({
    value: z.number().min(0).max(100),
    minimum: z.literal(0),
    maximum: z.literal(100),
    basis: z.literal("policy"),
    deductions: z.array(z.object({ ruleId: PolicyResultSchema.shape.ruleId, penalty: z.number().nonnegative() }).strict())
  }).strict(),
  benchmark: BenchmarkResultSchema.optional(),
  failures: z.array(FailureSchema)
}).strict();

export { CURRENT_RUN_SCHEMA_VERSION, LifecycleEventSchema, FailureSchema, PolicyResultSchema };
export type TaskRunResultRecord = z.infer<typeof TaskRunResultSchema>;
