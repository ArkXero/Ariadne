# ADR 0003: Serial Same-working-tree Execution

Status: accepted

Iteration 1 keeps serial execution in the canonical invocation tree. Every task receives a fresh baseline, but mutations persist for later tasks. Copy/worktree isolation and parallel mutation remain future work because they require explicit ownership, cleanup, dependency, and crash-reconciliation contracts.
