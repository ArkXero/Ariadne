# ADR 0009: Operational TUI through shared workflow services and process-local runtime events

## Status

Accepted.

## Context

The Iteration 5 TUI could inspect durable history but could not safely plan or control workflow execution. Calling command handlers from React would duplicate output policy and signal ownership. Persisting UI events would change stable schemas and make provisional rendering state look authoritative. Attempting process reattachment after restart would require a daemon and operating-system ownership protocol outside Ariadne's local CLI scope.

The established visual contract is locked: full alternate-screen fill, one-row header/footer, rounded zero-gutter panes, responsive `100/60/40` layouts, Coral identity/frames/failure/confirmation, and bold Cyan `>` focus text.

## Decision

- Introduce `workflow-application.ts` as the narrow service shared by `plan`, `run`, `resume`, `rerun`, and the TUI. Inspection and preview calls do not mutate history; launch returns a typed execution handle.
- Keep batch/run schemas unchanged. Emit immutable, monotonically sequenced runtime events only in memory.
- Redact process output before emission and preserve streaming UTF-8 boundaries. Preparation, agent, and verification processes have distinct lifecycle events.
- Deliver events asynchronously through per-subscriber queues bounded to 512 events and 1 MiB of output. Drop oldest output first, coalesce replaceable state, warn on truncation/gaps, preserve cancellation/completion, and disconnect subscribers that cannot accept non-droppable events.
- Keep a one-active-workflow registry outside React. It owns the handle, cancellation promise, subscriptions, and completion; persisted records remain authoritative after reconciliation.
- Do not claim restart-time process reattachment. Label persisted running/incomplete records without the registry handle as unattached.
- Require explicit confirmation for launch, cancellation, resume, rerun, and headless detach. Cancellation is idempotent.
- Restore terminal ownership before headless continuation and on render failure. External signals request cancellation and wait a bounded interval before restoring.
- Preserve the Iteration 5 visual contract and dependency set. Do not add promotion, discard, cleanup, browser UI, remote execution, daemon behavior, or mouse-first controls.

## Consequences

CLI commands and the TUI now share planning and launch semantics while retaining their existing output and exit contracts. Live output is responsive but deliberately lossy; complete evidence stays in artifacts. A TUI process controls only its own attached batch and cannot coordinate a second active batch. Headless detach still occupies the invoking shell because it is not background execution.

The registry/reducer boundary makes render failure non-fatal to the scheduler. Tests must cover event order, gaps, overflow, subscriber failure, process redaction/UTF-8, keyboard workflows, cancellation stages, persistence reconciliation, terminal teardown, and a real POSIX pseudo-terminal when available.
