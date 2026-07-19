import { z } from "zod";

const OutputPreviewSchema = z.object({
  head: z.string(),
  tail: z.string(),
  bytes: z.number().int().nonnegative(),
  encoding: z.literal("utf8-replacement"),
  hadDecodingReplacement: z.boolean()
}).strict();

export const ProcessResultSchema = z.object({
  kind: z.enum(["exec", "shell"]),
  executable: z.string(),
  args: z.array(z.string()),
  displayCommand: z.string(),
  cwd: z.string(),
  providedEnvironmentKeys: z.array(z.string()),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  interrupted: z.boolean(),
  spawnError: z.string().optional(),
  stdoutArtifact: z.string(),
  stderrArtifact: z.string(),
  stdoutPreview: OutputPreviewSchema,
  stderrPreview: OutputPreviewSchema,
  cleanup: z.object({
    attempted: z.boolean(),
    limitation: z.string().optional(),
    gracefulSignal: z.string().optional(),
    forceSignal: z.string().optional(),
    gracefulSucceeded: z.boolean().optional(),
    forceSucceeded: z.boolean().optional(),
    error: z.string().optional()
  }).strict(),
  redactionApplied: z.boolean().optional()
}).strict();
