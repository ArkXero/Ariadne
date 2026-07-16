# ADR 0007: Git-worktree isolation and explicit promotion

## Status

Accepted. Supersedes ADR 0003 for isolated execution; shared mode remains supported. Builds on ADR 0006 orchestration.

## Decision

Ariadne offers `shared` and `worktree` execution strategies. Worktree attempts use detached checkouts of recorded committed `HEAD`, layer successful dependency result commits in deterministic plan order, and capture successful safe changes as Ariadne-authored commits under `refs/ariadne/results/<run-id>`.

Execution records are immutable. Review and promotion are explicit commands. Apply requires the same repository and a clean named branch, preflights the unresolved result closure in a temporary worktree, creates one squashed commit based on the unchanged target HEAD, and cherry-picks only that commit into the primary checkout. Discard removes managed refs/worktrees while retaining historical evidence.

## Consequences

- Mutable tasks may overlap without sharing Git checkout state.
- Dirty primary changes are never copied, stashed, or committed. Explicit acknowledgement still uses `HEAD` only and records excluded dirt.
- Retries are fresh with respect to checkout state but not external caches, services, network, or operating-system state.
- Git worktrees are not a security sandbox. Secret detection, arbitrary subprocess visibility, and process-tree cleanup remain best effort.
- Containers, remotes, automatic merge/push, source-control abstraction, and hosted coordination remain out of scope.
