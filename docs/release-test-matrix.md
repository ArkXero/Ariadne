# Release Test Matrix

This matrix is the release-candidate coverage contract. `pnpm check` is the portable development gate; `pnpm release:check` creates a repository-owned source snapshot in a temporary directory, performs a frozen install, runs the complete gate twice, profiles bounded resources, audits production dependencies, and inspects the package without publishing.

| Product area | Automated coverage | Package / PTY coverage | Platform or manual coverage | Status |
| --- | --- | --- | --- | --- |
| Onboarding and detection | `config-task`, `init-onboarding`, `cli-integration` | Installed `init`, `doctor`; JavaScript, TypeScript, Python, Rust, Go, generic, no-HEAD, non-Git, cancellation, backup, atomic replacement | Interactive Default/Custom dogfood | Automated; Custom requires TTY |
| Configuration compatibility | `config-task`, `workflow-graph` | Versionless and v1-v4 package fixtures | Unsupported future/old versions must fail with migration guidance | Automated |
| Planning and scheduling | `workflow-graph`, `workflow-scheduler` | Installed dependency, retry, resume, rerun scenarios | 10,000-task deterministic wide graph in tests | Automated |
| Process execution and cancellation | `process-persistence`, `workflow-application`, `workflow-scheduler` | Timeout, interruption, failure and real installed binary | POSIX process-group escalation; Windows `taskkill` branch in CI | Automated; OS limits documented |
| Persistence and recovery | `process-persistence`, `report-history`, `workflow-history`, `release-hardening` | Corrupt history, latest pointers, interruption | 10/100/1,000/10,000 history profile | Automated |
| Git attribution and policies | `policy-git`, `process-persistence` | Dirty baseline, ignored forbidden file, policy failure | Modes/symlinks vary by platform | Automated; platform-specific cases explicit |
| Worktree isolation | `isolation-promotion`, `change-application` | Primary-checkout protection, retained workspaces, cleanup | Git worktree support required | Automated |
| Review, apply, rollback, discard | `isolation-promotion`, `change-application`, `tui-review` | Clean apply, target advancement, conflict rollback, idempotent discard | Unexpected primary conflict recovery remains manual if abort verification fails | Automated with documented recovery boundary |
| Reports and machine output | `report-history`, `workflow-history`, `cli-integration` | JSON purity, CSV formula neutralization, Markdown/HTML hostile-content escaping | Redirected stdout/stderr and `NO_COLOR` | Automated |
| TUI runtime and terminal | TUI component, reducer, service, runtime and terminal suites | Real POSIX PTY launch/monitor/cancel/review/resize/teardown; installed non-TTY refusal | Windows uses simulated terminal coverage; real-terminal dogfood is manual | Automated plus platform-specific/manual |
| Performance and bounds | `release-hardening`, `workflow-graph`, log/diff/runtime tests | `pnpm release:profile` | 10,000 history records/tasks, 1,000 workspaces/TUI records, 4 MiB log, 20,000-line diff | Measured, not a latency guarantee |
| Packaging and installation | `release-contract`, `package-smoke`, `smoke-test` | npm local/global/exec, pnpm local, direct binary, installed package PTY | Paths with spaces/Unicode; nested invocation safe failure | Automated |
| Documentation and examples | `release-contract` parses YAML fences and checks local links; example configs are exercised by smoke tests | Packed README/license/version checks | Manual review for prose accuracy | Automated syntax/link checks plus review |
| Dependency and supply chain | Frozen lockfile, exact pnpm version, `pnpm audit --prod` in release gate | Tarball allowlist and absolute-path scan | Audit is point-in-time evidence, not certification | Automated release gate |

## Required release evidence

- The supported CI matrix is Ubuntu on Node 20, 22, and 24 plus macOS and Windows on Node 22.
- POSIX PTY and signal scenarios may report an explicit unsupported-platform skip on Windows; no other release-critical skip is silent.
- A release recommendation is `NOT READY` while a P0/P1 issue or required gate fails. It is `READY WITH LIMITATIONS` when local gates pass but the resulting CI matrix has not run or accepted limitations remain. `READY` requires the complete supported CI matrix and no blocker.
- All mutation, interruption, apply, discard, and cleanup fixtures operate in disposable repositories. The release gate never publishes, tags, pushes, changes versions, or mutates a user project.
