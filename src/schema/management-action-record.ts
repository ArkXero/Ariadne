import { z } from "zod";
import { CURRENT_MANAGEMENT_ACTION_SCHEMA_VERSION } from "../types/index.js";

export const ManagementActionRecordSchema = z.object({
  schemaVersion: z.literal(CURRENT_MANAGEMENT_ACTION_SCHEMA_VERSION),
  actionId: z.string(),
  kind: z.enum(["patch-export", "workspace-cleanup"]),
  status: z.enum(["running", "succeeded", "partial", "failed", "interrupted"]),
  repositoryId: z.string(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  owner: z.object({ pid: z.number().int().positive(), hostname: z.string(), startedAt: z.string().datetime() }).strict(),
  runId: z.string().optional(),
  workspaceIds: z.array(z.string()),
  destination: z.string().optional(),
  bytes: z.number().int().nonnegative().optional(),
  outcomes: z.array(z.object({
    resourceId: z.string(), status: z.enum(["succeeded", "skipped", "failed"]), detail: z.string()
  }).strict()),
  error: z.string().optional()
}).strict();
