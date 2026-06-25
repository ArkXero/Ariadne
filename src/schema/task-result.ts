import { z } from "zod";
import { TraceSchema } from "./trace.js";

export const CURRENT_RUN_SCHEMA_VERSION = 1;

export const AriadneTaskSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  file: z.string().min(1),
  prompt: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional()
}).strict();

export const CommandExecutionSchema = z.object({
  command: z.string().min(1),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  runtimeMs: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  timedOut: z.boolean()
}).strict();

export const TaskScoreStatusSchema = z.enum([
  "passed",
  "agent_failed",
  "verification_failed",
  "check_failed",
  "timeout"
]);

export const CommandScoreSchema = z.object({
  command: z.string().min(1),
  passed: z.boolean(),
  exitCode: z.number().int(),
  timedOut: z.boolean(),
  runtimeMs: z.number().int().nonnegative()
}).strict();

export const ScoreCheckSchema = z.object({
  name: z.string().min(1),
  passed: z.boolean(),
  message: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional()
}).strict();

export const VerificationScoreSchema = z.object({
  passed: z.boolean(),
  commands: z.array(CommandScoreSchema),
  failedCommands: z.array(CommandScoreSchema)
}).strict();

export const TaskRunResultSchema = z.object({
  task: AriadneTaskSchema,
  durationMs: z.number().int().nonnegative().optional(),
  agent: CommandExecutionSchema,
  verification: z.array(CommandExecutionSchema),
  trace: TraceSchema,
  score: z.object({
    passed: z.boolean(),
    status: TaskScoreStatusSchema,
    agent: CommandScoreSchema,
    verification: VerificationScoreSchema,
    checks: z.array(ScoreCheckSchema)
  }).strict()
}).strict();

export type AriadneTaskRecord = z.infer<typeof AriadneTaskSchema>;
export type CommandExecutionRecord = z.infer<typeof CommandExecutionSchema>;
export type TaskRunResultRecord = z.infer<typeof TaskRunResultSchema>;
export type TaskScoreStatusRecord = z.infer<typeof TaskScoreStatusSchema>;
