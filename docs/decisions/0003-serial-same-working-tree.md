# ADR 0003: Serial Same-working-tree Execution

Status: superseded by ADR 0006

Iteration 1 keeps serial execution in the canonical invocation tree. Every task receives a fresh baseline, but mutations persist for later tasks. Copy/worktree isolation and parallel mutation remain future work because they require explicit ownership, cleanup, dependency, and crash-reconciliation contracts.

Iteration 2 retained the same tree with declaration-based overlap. Iteration 3 supersedes the serial-only decision by adding explicit Git-worktree isolation while preserving shared mode for compatibility. See [ADR 0007](./0007-git-worktree-isolation-and-explicit-promotion.md).
