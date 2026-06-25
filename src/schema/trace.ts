import { z } from "zod";

export const CURRENT_RUN_SCHEMA_VERSION = 1;

export const TraceSchema = z.object({
  gitAvailable: z.boolean(),
  workspaceDirtyBefore: z.array(z.string()),
  changedFiles: z.array(z.string()),
  forbiddenFileChanges: z.array(z.string()),
  diff: z.string(),
  diffLineCount: z.number().int().nonnegative(),
  commandsObserved: z.array(z.string())
}).strict();

export type Trace = z.infer<typeof TraceSchema>;
