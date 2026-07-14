# Testing Architecture

The executable test plan and commands live in [TESTING.md](../TESTING.md).

The suite is layered so failures remain local:

- unit tests cover schema, glob, command, policy, score, and renderer functions;
- component tests cover config/task adapters, process capture, Git state, persistence, and history;
- CLI integration tests execute the clean-built binary against temporary projects;
- smoke tests cover linked installation and representative pass/policy flows;
- packaging tests inspect and install the exact npm tarball;
- CI repeats the same gate on the supported OS/Node matrix.

All mutating tests use disposable directories and deterministic fake agents. Platform-specific process cleanup uses the production POSIX/Windows branch rather than claiming behavior from mocks.
