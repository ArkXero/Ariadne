# Lifecycle and Failure Semantics

## Child attempt lifecycle

Run record v4 uses `created`, `loading`, `validated`, `workspace_creating`, `workspace_ready`, `preparing`, `agent_running`, `agent_finished`, `verifying`, `collecting_trace`, `capturing_changes`, `workspace_cleanup`, `evaluating_policy`, `scoring`, `persisting`, and `completed`.

Preparation runs before the agent in worktree mode and has distinct spawn/nonzero/timeout/interruption evidence. An agent nonzero exit may still be verified. Spawn failure skips verification. A timeout permits later work only when cleanup is sufficiently confirmed. Shared retries use the current tree; isolated retries create fresh worktrees from source plus successful dependency results.

After verification, isolated attempts capture safe changes, create a durable result ref when non-empty, persist applicability, and apply retention cleanup. Failed/interrupted/ineligible worktrees are retained under `on-failure`; `never` removes them and `always` retains them.

## Batch lifecycle

Batch record v1 checkpoints `created`, `planning`, `running`, `cancelling`, `persisting`, and `completed`. Running events name readiness, attempt starts/finishes, retry waits, terminal transitions, blocking, and scheduler checkpoints. The scheduler persists after planning and every material task, attempt, retry, blocking, interruption, and aggregation transition.

In `continue` mode, a final failure blocks dependents while unrelated branches continue. In `fail-fast` mode, the first final failure stops new launches; dependents become blocked and unrelated pending work becomes skipped. Retry delays consume no execution slot.

## Interruption and recovery

One SIGINT/SIGTERM coordinator stops launches, cancels retry waits, aborts active attempts, waits for bounded process cleanup, and persists child and batch terminal state. A second signal exits immediately and can bypass final persistence.

Resume never mutates source history. It validates semantic fingerprint, source revision, isolation, and surviving successful result refs; uncertain isolated workspaces are never reused. Rerun creates a new batch from current configuration and reruns dependencies.

Apply/discard create separate promotion events. Apply transitions through validating, preflighting, applying, and succeeded/conflicted/failed. Preflight conflicts leave the primary checkout untouched. Discard preserves manifests, logs, reports, and safe artifacts.

Manifest writes use exclusive directories and same-directory atomic replacement with file sync and best-effort directory sync. Same-host running records with dead owners are presented as abandoned, not silently rewritten.
