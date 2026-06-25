# Task Isolation

Ariadne currently runs tasks serially in the configured working tree. That is simple and transparent, but it means tasks can affect later tasks unless users clean or isolate the workspace themselves.

## Same Working Tree

Pros:

- easiest to understand;
- no copy or worktree setup cost;
- works with any local repository state;
- matches current MVP behavior.

Cons:

- tasks can contaminate later tasks;
- generated files can accumulate;
- parallel mutation would be unsafe;
- failures can be harder to attribute when previous tasks changed the same files.

Failure modes:

- task A leaves files that make task B pass or fail incorrectly;
- ignored files such as `.env` persist after a failed task;
- agent cleanup scripts remove files needed by later tasks.

## Temporary Copied Workspace

Pros:

- each task can start from a clean copy;
- no mutation of the source repository;
- easier to delete after a run;
- works without requiring extra git branches.

Cons:

- copying large repositories can be slow;
- ignored dependencies like `node_modules` may need a reinstall or explicit copy policy;
- symlinks and platform-specific files need careful handling.

Failure modes:

- copy excludes files needed by tests;
- dependency install differs from source workspace;
- large binary files make runs slow.

## Git Worktree Per Task

Pros:

- clean git-native isolation;
- efficient for large repositories;
- good foundation for safe future concurrency;
- preserves traceability through git status and diff.

Cons:

- requires a git repository;
- needs branch/name cleanup after interrupted runs;
- untracked and ignored source files require explicit policy;
- nested worktrees and submodules add complexity.

Failure modes:

- stale worktrees remain after crash;
- task depends on untracked local files not present in the worktree;
- branch names collide across repeated runs.

## Recommendation

For Ariadne MVP+, keep same-working-tree execution as the default and document its limits. Add explicit isolation modes before enabling mutating parallel execution.

Phased plan:

1. Add `--isolation same-worktree` as an explicit name for current behavior.
2. Add `--isolation copy` using a temporary directory, with conservative ignore rules and full trace paths.
3. Add `--isolation git-worktree` for git repositories.
4. Add serial execution tests for each isolation mode.
5. Add limited concurrency only for isolated modes, never for shared same-working-tree mutation.
