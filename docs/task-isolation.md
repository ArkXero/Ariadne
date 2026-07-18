# Task Isolation

Ariadne supports shared and managed Git-worktree execution. Every attempt captures a fresh baseline. Shared mutations persist across retries; worktree retries start from a fresh detached checkout. Tasks remain exclusive by default unless their workspace contract and isolation strategy permit overlap.

Config v4 separates task intent from execution strategy. `workspaceMode: mutable` is the default. In shared isolation, mutable tasks are exclusive and `workspaceMode: read-only` tasks may overlap; any Git-visible read-only mutation fails `workspace.read-only` whether or not another task overlaps.

With `execution.isolation: worktree`, every attempt gets a detached checkout under `.ariadne/worktrees/<workspace-id>/checkout`. Mutable tasks may overlap up to the concurrency bound. Successful dependency result commits are layered in stable plan order. Retries create fresh worktrees; failed-attempt mutations are never inherited.

Worktrees isolate Git repository state only. They do not limit network access, operating-system permissions, writes outside the checkout, services, caches, credentials, or arbitrary child-process side effects. Ignored or externally redirected mutations may be invisible.

## Cleanup ownership

Workspace inspection computes bounded disk usage with `lstat` and never traverses symlinks. Cleanup requires the recorded repository ID, a `ws-` identifier, the exact `.ariadne/worktrees/<id>/checkout` path, an eligible owner/state, and matching directory or Git registration evidence. Unknown, active, corrupt, path-escaping, or otherwise unprovable resources are skipped. A missing checkout is an idempotent cleanup case; history and lifecycle metadata remain.

Cleanup preview and CLI `--dry-run` perform no mutation and create no management-action record. Confirmed selected/bulk cleanup is serialized with promotion, discard, and export. Partial failures remain recorded and retryable.
