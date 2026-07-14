import { z } from "zod";
import { RunRecordSchema } from "./run-record.js";
import { CURRENT_RUN_SCHEMA_VERSION } from "../types/index.js";

export const ReportSchema = z.object({
  run: RunRecordSchema,
  generatedAt: z.string().datetime().optional(),
  outputPath: z.string().min(1).optional()
}).strict();

export { CURRENT_RUN_SCHEMA_VERSION };
export type ReportRecord = z.infer<typeof ReportSchema>;
