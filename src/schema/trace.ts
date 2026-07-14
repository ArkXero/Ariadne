import { z } from "zod";
import { CURRENT_RUN_SCHEMA_VERSION } from "../types/index.js";

const RepositoryEntrySchema = z.object({
  path: z.string(),
  originalPath: z.string().optional(),
  indexStatus: z.string(),
  worktreeStatus: z.string(),
  changeType: z.enum(["added", "modified", "deleted", "renamed", "copied", "mode-changed", "symlink-changed", "untracked", "ignored"]),
  kind: z.enum(["file", "symlink", "other"]).optional(),
  mode: z.string().optional(),
  fingerprint: z.string().optional()
}).strict();

const RepositorySnapshotSchema = z.object({
  available: z.boolean(),
  unavailableReason: z.string().optional(),
  head: z.string().optional(),
  branch: z.string().optional(),
  detached: z.boolean().optional(),
  dirty: z.boolean(),
  entries: z.array(RepositoryEntrySchema),
  diffLineCount: z.number().int().nonnegative()
}).strict();

const ChangeEvidenceSchema = z.object({
  path: z.string(),
  originalPath: z.string().optional(),
  changeType: RepositoryEntrySchema.shape.changeType,
  source: z.enum(["agent", "verification", "agent-and-verification"]),
  baselineFingerprint: z.string().optional(),
  finalFingerprint: z.string().optional()
}).strict();

const ForbiddenFileStateSchema = z.object({
  fingerprint: z.string(),
  kind: z.enum(["file", "symlink", "other"]),
  mode: z.string()
}).strict();

export const TraceSchema = z.object({
  baseline: RepositorySnapshotSchema,
  postAgent: RepositorySnapshotSchema,
  final: RepositorySnapshotSchema,
  preexistingChanges: z.array(RepositoryEntrySchema),
  agentChanges: z.array(ChangeEvidenceSchema),
  verificationChanges: z.array(ChangeEvidenceSchema),
  taskChanges: z.array(ChangeEvidenceSchema),
  forbiddenFileChanges: z.array(ChangeEvidenceSchema.extend({
    rule: z.string(),
    baselineState: ForbiddenFileStateSchema.optional(),
    finalState: ForbiddenFileStateSchema.optional()
  }).strict()),
  diffArtifact: z.string().optional(),
  diffLineCount: z.number().int().nonnegative(),
  observedCommands: z.array(z.object({
    source: z.enum(["agent-config", "verification-config", "agent-output", "verification-output"]),
    representation: z.string(),
    confidence: z.enum(["executed", "reported", "blocked"])
  }).strict())
}).strict();

export { CURRENT_RUN_SCHEMA_VERSION };
export type Trace = z.infer<typeof TraceSchema>;
