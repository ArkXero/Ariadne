# Task Isolation

Ariadne uses one canonical working tree. Every attempt captures a fresh baseline, but mutations persist across retries and tasks. Tasks are exclusive by default.

Config v4 separates task intent from execution strategy. `workspaceMode: mutable` is the default. In shared isolation, mutable tasks are exclusive and `workspaceMode: read-only` tasks may overlap; any Git-visible read-only mutation fails `workspace.read-only` whether or not another task overlaps.

With `execution.isolation: worktree`, every attempt gets a detached checkout under `.ariadne/worktrees/<workspace-id>/checkout`. Mutable tasks may overlap up to the concurrency bound. Successful dependency result commits are layered in stable plan order. Retries create fresh worktrees; failed-attempt mutations are never inherited.

Worktrees isolate Git repository state only. They do not limit network access, operating-system permissions, writes outside the checkout, services, caches, credentials, or arbitrary child-process side effects. Ignored or externally redirected mutations may be invisible.

## Deferred isolation modes

A temporary copy could protect the source checkout but must define copy rules, dependency handling, symlinks, large files, and cleanup. A Git worktree per task could provide efficient Git-native separation but must reconcile dirty/untracked input, stale worktrees, branches, submodules, and crashes.

Neither mode exists in this release. Safe self-hosting examples create disposable Git repositories. The next isolation iteration should add an explicit copy/worktree ownership contract before claiming safe mutation concurrency.
