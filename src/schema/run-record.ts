import { z } from "zod";
import { TaskRunResultSchema, TaskScoreStatusSchema } from "./task-result.js";

export const CURRENT_RUN_SCHEMA_VERSION = 1;

export const AriadneConfigSchema = z.object({
  version: z.number().int().positive(),
  agent: z.object({
    command: z.string().min(1),
    timeout_ms: z.number().int().positive()
  }).strict(),
  tasks: z.object({
    directory: z.string().min(1)
  }).strict(),
  verification: z.object({
    commands: z.array(z.string().min(1)),
    timeout_ms: z.number().int().positive()
  }).strict(),
  checks: z.object({
    forbidden_files: z.array(z.string().min(1)),
    max_changed_files: z.number().int().nonnegative().optional(),
    max_diff_lines: z.number().int().nonnegative().optional(),
    forbidden_commands: z.array(z.string().min(1))
  }).strict()
}).strict();

export const RunSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  status: TaskScoreStatusSchema
}).strict();

export const RunRecordSchema = z.object({
  schemaVersion: z.literal(CURRENT_RUN_SCHEMA_VERSION),
  version: z.literal(CURRENT_RUN_SCHEMA_VERSION),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
  cwd: z.string().min(1),
  configPath: z.string().min(1),
  config: AriadneConfigSchema,
  results: z.array(TaskRunResultSchema),
  summary: RunSummarySchema
}).strict();

export const AriadneRunSchema = RunRecordSchema;

export function getRunSchemaVersion(run: { schemaVersion?: number; version?: number }): number {
  return run.schemaVersion ?? run.version ?? CURRENT_RUN_SCHEMA_VERSION;
}

export type AriadneConfigRecord = z.infer<typeof AriadneConfigSchema>;
export type RunSummaryRecord = z.infer<typeof RunSummarySchema>;
export type RunRecord = z.infer<typeof RunRecordSchema>;
