import { z } from "zod";
import { CURRENT_PROMOTION_SCHEMA_VERSION } from "../types/index.js";

const Status = z.enum(["validating", "preflighting", "applying", "succeeded", "conflicted", "discarded", "interrupted", "failed"]);
const Conflict = z.object({
  path: z.string(),
  category: z.enum(["content", "modify-delete", "rename", "binary", "unknown"])
}).strict();
const Failure = z.object({
  category: z.enum(["ineligible", "dirty-target", "wrong-repository", "already-applied", "missing-artifact", "missing-result", "conflict", "git", "interrupted", "cleanup", "persistence", "stale-preview", "unknown"]),
  code: z.string(), message: z.string(), targetModified: z.boolean(), rollbackAttempted: z.boolean(),
  rollbackSucceeded: z.boolean().optional(), manualRecoveryRequired: z.boolean(), recoveryCommands: z.array(z.string())
}).strict();
const Base = z.object({
  promotionId: z.string(), kind: z.enum(["apply", "discard"]), status: Status,
  runId: z.string(), includedRunIds: z.array(z.string()), repositoryId: z.string(), targetBranch: z.string().optional(),
  preApplyRevision: z.string().optional(), postApplyRevision: z.string().optional(), promotionCommit: z.string().optional(),
  strategy: z.literal("preflight-squash-cherry-pick").optional(), conflictPaths: z.array(z.string()), startedAt: z.string().datetime(), updatedAt: z.string().datetime(), completedAt: z.string().datetime().optional(),
  owner: z.object({ pid: z.number().int().positive(), hostname: z.string(), startedAt: z.string().datetime() }).strict(),
  lifecycle: z.array(z.object({ status: Status, at: z.string().datetime(), detail: z.string().optional() }).strict()),
  cleanup: z.object({ preflightPath: z.string().optional(), removed: z.boolean().optional(), error: z.string().optional() }).strict().optional(), error: z.string().optional()
});

const PromotionRecordV1Schema = Base.extend({ schemaVersion: z.literal(1) }).strict();
const PromotionRecordV2Schema = Base.extend({
  schemaVersion: z.literal(CURRENT_PROMOTION_SCHEMA_VERSION),
  conflicts: z.array(Conflict).optional(),
  failure: Failure.optional(),
  discard: z.object({
    resultRefRemoved: z.boolean(), workspaceId: z.string().optional(),
    workspaceState: z.enum(["creating", "ready", "preparing", "running", "capturing", "retained", "removing", "removed", "stale", "failed"]).optional(),
    historyPreserved: z.literal(true)
  }).strict().optional()
}).strict();

export const PromotionRecordSchema = z.union([PromotionRecordV1Schema, PromotionRecordV2Schema]);
