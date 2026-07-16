import { z } from "zod";
import { CURRENT_PROMOTION_SCHEMA_VERSION } from "../types/index.js";

const Status = z.enum(["validating", "preflighting", "applying", "succeeded", "conflicted", "discarded", "interrupted", "failed"]);
export const PromotionRecordSchema = z.object({
  schemaVersion: z.literal(CURRENT_PROMOTION_SCHEMA_VERSION), promotionId: z.string(), kind: z.enum(["apply", "discard"]), status: Status,
  runId: z.string(), includedRunIds: z.array(z.string()), repositoryId: z.string(), targetBranch: z.string().optional(),
  preApplyRevision: z.string().optional(), postApplyRevision: z.string().optional(), promotionCommit: z.string().optional(),
  strategy: z.literal("preflight-squash-cherry-pick").optional(), conflictPaths: z.array(z.string()), startedAt: z.string().datetime(), updatedAt: z.string().datetime(), completedAt: z.string().datetime().optional(),
  owner: z.object({ pid: z.number().int().positive(), hostname: z.string(), startedAt: z.string().datetime() }).strict(),
  lifecycle: z.array(z.object({ status: Status, at: z.string().datetime(), detail: z.string().optional() }).strict()),
  cleanup: z.object({ preflightPath: z.string().optional(), removed: z.boolean().optional(), error: z.string().optional() }).strict().optional(), error: z.string().optional()
}).strict();
