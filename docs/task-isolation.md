# Task Isolation

Ariadne runs tasks serially in the canonical invocation working tree. Every task receives a fresh repository baseline and failures are attributed independently, but filesystem mutations remain in place and can affect later tasks.

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
- later tasks can observe files left by earlier tasks, even though attribution begins from a new baseline.

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

For the reliability foundation, same-working-tree serial execution remains the only mode. The safe dogfooding examples create a separate temporary repository per scenario. Add explicit isolation modes before enabling parallel mutation.

Phased plan:

1. Add `--isolation same-worktree` as an explicit name for current behavior.
2. Add `--isolation copy` with conservative copy rules, canonical roots, and cleanup ownership.
3. Add `--isolation git-worktree` with crash reconciliation.
4. Test dirty, untracked, ignored, symlink, submodule, and interruption behavior for each mode.
5. Permit concurrency only for independently isolated workspaces.
