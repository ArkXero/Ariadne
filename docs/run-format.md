# Record Formats

## Task run record v4

Every task attempt owns `.ariadne/runs/<run-id>/run.json`. Run record v4 retains prior execution evidence and adds a workspace reference, source/prepared/result revisions, inherited results, preparation processes, retention/cleanup, and a change-artifact reference. Its optional `workflow` link records batch, plan, task, and globally increasing attempt number.

Full stdout/stderr bytes remain in artifact files. Manifests keep bounded head/tail previews, byte counts, UTF-8 replacement metadata, and spawn/exit/signal/timeout/interruption/cleanup distinctions. Prompt text and environment values are omitted; prompt length and SHA-256 are stored.

Run readers preserve v1 flat-file and v2/v3 directory compatibility without rewriting history. Missing artifacts become warnings. Malformed and future records are skipped by history and explained by explicit reports.

## Batch record v2

Each invocation owns `.ariadne/batches/<batch-id>/batch.json`. The record includes:

- compatibility fields `kind`, `runId`, run-like `status`, `outcome`, and `tasks`, plus `batchId` and the more specific `batchStatus`;
- graph edges, selected roots, closure, levels, stable order, plan ID, and semantic fingerprint;
- effective concurrency, failure mode, isolation, workspace mode, retention, verification, retry, and dependency-result settings;
- task states, all child attempt references, retry decisions, block/skip evidence, and relation to a resumed/rerun source;
- owner, repository HEAD, lifecycle checkpoints, warnings, failures, aggregate counts, and score summary.

The batch never duplicates child traces or logs. Batch score is the arithmetic mean of final-attempt policy scores for launched tasks; blocked/skipped tasks are excluded and score never determines status.

Task states are `pending`, `ready`, `running`, `retry_wait`, `succeeded`, `failed`, `blocked`, `skipped`, `interrupted`, and `incomplete`. Terminal batch statuses are `succeeded`, `succeeded_with_warnings`, `partially_failed`, `failed`, `interrupted`, and `incomplete`; readers may derive `abandoned` for a dead same-host owner.

## Pointers and privacy

- `.ariadne/runs/latest.json`: latest terminal child attempt.
- `.ariadne/batches/latest.json`: latest terminal batch.
- `.ariadne/latest.json`: latest completed invocation and its record kind.

Workspace record v1 lives at `.ariadne/worktrees/<workspace-id>/workspace.json`. Change-artifact v2 lives with the child run and adds stable change IDs, old/new Git object/path/kind/mode/size/symlink metadata, binary/rename/copy similarity, and hashed bounded per-file text-diff metadata. Promotion-record v2 lives under `.ariadne/promotions/` and adds structured conflicts, failure category/code, target-modified/rollback state, manual-recovery commands, and discard cleanup details. Change/promotion v1 records normalize on read without rewriting.

Management-action v1 lives under `.ariadne/actions/` for completed/interrupted patch exports and workspace cleanup. Cleanup dry-run creates no action. Apply, discard, export, and cleanup never rewrite execution records or execution latest pointers.

Pointers update only after valid terminal manifests exist. Paths are project-relative POSIX strings and repository identity is opaque. Configured forbidden and high-confidence sensitive paths are excluded from result commits/patches. Streaming log and preview redaction is best effort; Ariadne is not a secrets vault.
