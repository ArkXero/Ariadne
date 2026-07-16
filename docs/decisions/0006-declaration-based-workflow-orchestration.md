# ADR 0006: Declaration-based Workflow Orchestration

Status: accepted

Iteration 2 adds deterministic dependency planning, retries, batches, resume/rerun, and bounded overlap without adding workspace isolation. Tasks remain exclusive by default. Only tasks explicitly marked `parallelSafe` may overlap, and Git-visible mutation during an overlap fails the affected cohort conservatively.

This preserves the Iteration 1 attempt executor and evidence model while making workflow behavior explicit and recoverable. The declaration is not a sandbox guarantee: ignored, external, or otherwise invisible mutations can evade detection. Worktree/copy isolation is deferred to a separate iteration.
