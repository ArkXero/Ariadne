# Testing Architecture

The executable test plan and commands live in [TESTING.md](../TESTING.md).

The suite is layered so failures remain local:

- unit tests cover schema, graph/planner determinism, glob, command, policy, score, and renderer functions;
- component tests cover config/task adapters, process capture, Git state, persistence, and history;
- scheduler/control tests use deterministic process gates for concurrency, retries, propagation, interruption, resume, and rerun;
- isolation/promotion tests use disposable Git repositories for worktree lifecycle, dependency layering, capture/omission, preflight conflicts, apply/discard, and cleanup;
- CLI integration tests execute the clean-built binary against temporary projects;
- smoke tests cover linked installation and representative pass/policy flows;
- packaging tests inspect and install the exact npm tarball;
- CI repeats the same gate on the supported OS/Node matrix.

All mutating and dogfood tests use disposable directories and deterministic fake agents. Platform-specific process cleanup uses the production POSIX/Windows branch rather than claiming behavior from mocks. Timing assertions use file/process gates instead of arbitrary sleeps wherever practical.
