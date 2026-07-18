# ADR 0010: Change Review Application Services and Safe Management Actions

- Status: accepted
- Date: 2026-07-18

## Context

The operational Ink TUI could plan, run, monitor, cancel, resume, and rerun, but result review and repository management remained split across CLI handlers and Git-owning core functions. Adding apply, discard, export, and workspace cleanup directly to React components would duplicate policy, weaken ownership checks, and make interruption/terminal teardown unsafe. Existing run v4 and batch v2 records must remain immutable, and historical change/promotion v1 artifacts cannot be migrated in place.

Full-file diff rendering is also unsafe for terminal responsiveness and secret handling. Workspace cleanup must distinguish proven Ariadne resources from unknown directories even after crashes or missing Git registration.

## Decision

Introduce `change-application` and `workspace-application` as the shared typed boundary for CLI and TUI consumers. Components receive display models and callbacks; they never invoke Git, inspect refs, read arbitrary artifacts, copy patches, calculate disk usage, mutate history, or delete directories.

New captures use change-artifact v2. Every safe file has a stable change ID plus old/new path, Git object, kind, mode, size, symlink target, binary, rename/copy similarity, and text-diff metadata. Text artifacts are hashed and capped at 8 MiB/1,000 hunks. Binary and sensitive content has no per-file text artifact. V1 artifacts retain their bounded whole-preview adapter and are never rewritten.

Viewer requests use opaque cursors, read at most 64 KiB, and return at most 400 parsed lines with line numbers. Renderers sanitize terminal controls and cap display lines at 240 columns. Complete safe patch export remains available outside the bounded viewer and is no-clobber unless a CLI caller explicitly requests force.

New promotion events use promotion-record v2 with typed conflicts, failure category/code, target-modified and rollback state, manual-recovery requirement, sanitized recovery commands, and discard cleanup. V1 promotion events normalize to v2 in memory. Apply uses a transient preflight and a fingerprint over repository identity, branch, target revision, run, and dependency closure. Execution revalidates that fingerprint under one exclusive management lock. Only standalone runs and final workflow attempts are promotable.

Patch exports and workspace cleanup write management-action v1 records. Cleanup dry runs are pure and create no record. Workspace cleanup requires matching repository identity, a `ws-` identifier, the exact managed path, eligible owner/state, and registration/directory evidence. Disk usage and cleanup validation use `lstat` and do not follow symlinks. Missing directories are idempotent; unknown, active, corrupt, or unprovable resources are skipped.

Apply conflicts are aborted with `git cherry-pick --abort`, then HEAD and operation state are verified. Ariadne never uses a destructive reset to hide a conflict and never provides an embedded merge editor. Failed abort verification becomes explicit manual recovery rather than a false success.

## Consequences

- CLI and TUI behavior share repository, artifact, eligibility, discard, export, and cleanup checks.
- Run and batch schemas remain unchanged and immutable; new action history is additive.
- Review remains responsive for large files and hostile output, at the cost of intentionally incomplete in-TUI browsing.
- Promotion preflight reduces but cannot eliminate races or platform-specific Git behavior; execution fingerprint validation closes the known target/closure race.
- A management action may finish after interruption is requested when stopping at that instant would be less safe. The TUI remains locked and waits for service recovery before exiting.
- Conflict resolution, remote source-control operations, search, and automatic merge remain out of scope.
