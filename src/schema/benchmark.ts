import { z } from "zod";
import { ProcessResultSchema } from "./process-result.js";

export const BenchmarkAnchorSchema = z.union([
  z.literal(0), z.literal(10), z.literal(20), z.literal(30), z.literal(40), z.literal(50),
  z.literal(60), z.literal(70), z.literal(80), z.literal(90), z.literal(100)
]);

export const BenchmarkFailureActionSchema = z.union([
  z.enum(["zero", "keep", "disqualify"]),
  z.object({ cap: z.number().min(0).max(100) }).strict()
]);

export const BenchmarkJudgeResponseSchema = z.object({
  score: z.number().int().min(0).max(100),
  lower_anchor: BenchmarkAnchorSchema,
  upper_anchor: BenchmarkAnchorSchema,
  reason: z.string().trim().min(1),
  evidence: z.array(z.string().trim().min(1)).min(1)
}).strict();

export const BenchmarkResultSchema = z.object({
  schemaVersion: z.literal(1),
  benchmarkId: z.string(),
  taskId: z.string(),
  executionOutcome: z.enum(["passed", "preparation_failed", "agent_failed", "verification_failed", "policy_failed", "timeout", "interrupted", "internal_failed"]),
  policyScore: z.number().min(0).max(100),
  status: z.enum(["scored", "unscored", "failed"]),
  qualification: z.enum(["qualified", "disqualified", "unscored"]),
  candidateModel: z.string(),
  judgeModel: z.string(),
  blindCandidateIdentity: z.boolean(),
  rawScore: z.number().int().min(0).max(100).optional(),
  effectiveScore: z.number().min(0).max(100).nullable().optional(),
  failurePolicy: z.object({
    outcome: z.enum(["agent_failed", "verification_failed", "timeout", "policy_failed"]),
    action: BenchmarkFailureActionSchema
  }).strict().optional(),
  reason: z.string().optional(),
  evidence: z.array(z.string()).optional(),
  fingerprints: z.object({ benchmark: z.string(), context: z.string().optional(), packet: z.string().optional() }).strict(),
  packet: z.object({
    artifact: z.string(),
    includedChangedFiles: z.array(z.string()),
    includedContextFiles: z.array(z.string()),
    omissions: z.array(z.object({
      path: z.string(),
      source: z.enum(["changed", "context", "diff"]),
      reason: z.enum(["binary", "oversized", "forbidden", "secret-like", "symlink", "outside-root", "missing", "not-file", "unavailable"]),
      detail: z.string().optional()
    }).strict())
  }).strict().optional(),
  judge: z.object({ response: BenchmarkJudgeResponseSchema.optional(), process: ProcessResultSchema }).strict().optional(),
  failure: z.object({ code: z.string(), message: z.string() }).strict().optional()
}).strict().superRefine((result, context) => {
  if (result.status === "scored") {
    if (result.rawScore === undefined) context.addIssue({ code: "custom", path: ["rawScore"], message: "A scored benchmark requires a raw score." });
    if (!result.judge?.response) context.addIssue({ code: "custom", path: ["judge", "response"], message: "A scored benchmark requires a validated judge response." });
    if (result.qualification === "qualified" && typeof result.effectiveScore !== "number") context.addIssue({ code: "custom", path: ["effectiveScore"], message: "A qualified scored benchmark requires an effective score." });
    if (result.qualification === "disqualified" && result.effectiveScore !== null) context.addIssue({ code: "custom", path: ["effectiveScore"], message: "A disqualified benchmark must have a null effective score." });
    if (result.qualification === "unscored") context.addIssue({ code: "custom", path: ["qualification"], message: "A scored benchmark cannot be unscored." });
  } else {
    if (result.qualification !== "unscored") context.addIssue({ code: "custom", path: ["qualification"], message: "A non-scored benchmark must be unscored." });
    if (result.rawScore !== undefined || result.effectiveScore !== undefined) context.addIssue({ code: "custom", path: ["rawScore"], message: "A non-scored benchmark cannot contain numeric scores." });
    if (result.status === "failed" && !result.failure) context.addIssue({ code: "custom", path: ["failure"], message: "A failed benchmark requires structured failure details." });
  }
  if (result.rawScore !== undefined && result.judge?.response && result.rawScore !== result.judge.response.score) {
    context.addIssue({ code: "custom", path: ["rawScore"], message: "Raw score must equal the validated judge response score." });
  }
  if (result.failurePolicy && result.failurePolicy.outcome !== result.executionOutcome) {
    context.addIssue({ code: "custom", path: ["failurePolicy", "outcome"], message: "Failure policy outcome must equal executionOutcome." });
  }
});
