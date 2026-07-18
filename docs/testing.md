# Testing Architecture

The executable test plan and commands live in [TESTING.md](../TESTING.md).

The suite is layered so failures remain local:

- unit tests cover schema, graph/planner determinism, glob, command, policy, score, and renderer functions;
- component tests cover config/task adapters, process capture, Git state, persistence, and history;
- scheduler/control tests use deterministic process gates for concurrency, retries, propagation, interruption, resume, and rerun;
- isolation/promotion tests use disposable Git repositories for worktree lifecycle, dependency layering, v2 capture/omission, bounded diff paging, clean/stale/conflicting apply, idempotent discard, patch export collision, and cleanup ownership;
- CLI integration tests execute the clean-built binary against temporary projects;
- smoke tests cover linked installation and representative pass/policy flows;
- TUI tests cover compatibility/application services, selection and option replanning, result/manifest/diff navigation, risk-gated apply, discard, pure cleanup preview/confirmation, runtime event ordering/gaps/subscriber failure, retry/block reduction, bounded live output, navigation/focus, filters, responsive full-height layouts, footer packing, ASCII/monochrome fallback, detach/reopen, headless continuation, signal finalization, and idempotent teardown;
- the dependency-free Python driver exercises an actual POSIX pseudo-terminal for planning, launch, live output, dashboard/review navigation, detach/reopen, cancellation, resize signaling, and restoration; unsupported platforms retain simulated-TTY coverage;
- packaging tests inspect and install the exact npm tarball;
- release-contract tests validate package metadata, the tarball allowlist, documentation links, and YAML examples;
- release profiling records deterministic 10/100/1,000/10,000-record, 1,000-workspace/TUI, 10,000-task workflow, and 4 MiB-log evidence without wall-clock pass/fail thresholds; a separate deterministic test checks a 20,000-line diff through the bounded pager;
- CI repeats the same gate on the supported OS/Node matrix.

All mutating and dogfood tests use disposable directories and deterministic fake agents. Platform-specific process cleanup uses the production POSIX/Windows branch rather than claiming behavior from mocks. Timing assertions use file/process gates instead of arbitrary sleeps wherever practical.

Use `pnpm release:check` for a release-candidate decision. It copies only repository-owned files into a disposable source snapshot, performs a frozen install, runs `pnpm check` twice, profiles bounded resources, audits production dependencies, validates the package contract, inspects the tarball, and checks whitespace. It never publishes, tags, pushes, or changes the package version.
