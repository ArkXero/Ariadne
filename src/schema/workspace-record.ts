import { z } from "zod";
import { CURRENT_WORKSPACE_SCHEMA_VERSION } from "../types/index.js";

const WorkspaceStateSchema = z.enum(["creating", "ready", "preparing", "running", "capturing", "retained", "removing", "removed", "stale", "failed"]);

export const WorkspaceRecordSchema = z.object({
  schemaVersion: z.literal(CURRENT_WORKSPACE_SCHEMA_VERSION),
  workspaceId: z.string(), runId: z.string(), batchId: z.string(), planId: z.string(), taskId: z.string(), attempt: z.number().int().positive(),
  repositoryId: z.string(), sourceRevision: z.string(), preparedRevision: z.string().optional(), path: z.string(), metadataPath: z.string(),
  state: WorkspaceStateSchema, retention: z.enum(["always", "on-failure", "never"]), retentionReason: z.string().optional(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  owner: z.object({ pid: z.number().int().positive(), hostname: z.string(), startedAt: z.string().datetime() }).strict(),
  lifecycle: z.array(z.object({ state: WorkspaceStateSchema, at: z.string().datetime(), detail: z.string().optional() }).strict()),
  cleanupAt: z.string().datetime().optional(), cleanupError: z.string().optional()
}).strict();
