import { z } from "zod";
import { RunRecordSchema } from "./run-record.js";

export const CURRENT_RUN_SCHEMA_VERSION = 1;

export const ReportSchema = z.object({
  run: RunRecordSchema,
  generatedAt: z.string().datetime().optional(),
  outputPath: z.string().min(1).optional()
}).strict();

export type ReportRecord = z.infer<typeof ReportSchema>;
