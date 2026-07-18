# Changelog

## Unreleased

### Added

- Operational `ariadne tui` planning, task selection, option editing, explicit launch confirmation, live task/process/output monitoring, cancellation confirmation/progress, dashboard detach/reopen, and confirmed headless continuation.
- Shared workflow inspection/preview/launch services for CLI and TUI, typed in-memory runtime events, bounded asynchronous subscriptions, redacted UTF-8 process streaming, one-active-workflow registry, persistence reconciliation, and idempotent cancellation handles.
- Resume and failed/failed-branch/all-root rerun previews in workflow history, with current-configuration replanning and immutable source records.
- Bounded 500-line/256 KiB live buffers, retry countdowns, blocked dependency chains, preparation/agent/verification process separation, subscriber overflow/sequence-gap warnings, and unattached-runtime labeling.
- Operational TUI behavior tests plus a POSIX system-PTY smoke harness for planning, monitoring, detach/reopen, cancellation, resize signaling, and terminal teardown.
- Shared semantic design tokens across interactive Init, the Ink TUI, and generated run/workflow HTML reports, including Green success, Cyan selection/running, Coral frames/failure, Orange warning, and Slate metadata in the TUI.
- A fixed-height, row-one TUI shell with a compact header/footer, windowed lists, rounded zero-gutter frames, and Lazygit-inspired master/detail panes on wide terminals; compact and stacked terminals preserve drill-down navigation.
- `ariadne tui`, initially introduced with dashboard, filtered history, workflow/task/attempt detail, warnings, contextual help, responsive Unicode/ASCII layouts, refresh, and safe terminal teardown.
- Typed TUI application services, structured warning codes, stable legacy multi-task history entries, contained 64 KiB log-tail previews, terminal-control sanitization, and terminal-oriented reducer/component/adapter tests.

- Interactive `ariadne init` onboarding with repository-aware Default setup, full Custom setup, detected package scripts/agents/worktree capability, and pre-write YAML/file-change review.
- Safe existing-config validation and replacement with mandatory diffs, disposable proposal validation, ignored timestamped backups, atomic writes, and rollback.
- Configuration v4 with shared/worktree isolation, task workspace modes, retention, and bounded workspace preparation.
- Managed detached worktrees, fresh retry workspaces, deterministic dependency-result layering, and primary-checkout mutation guards.
- Run record v4, batch record v2, workspace/change/promotion v1 records, durable local result refs, safe patches, and separate immutable promotion events.
- `changes`, `diff`, `status`, `apply`, `discard`, and guarded worktree inspection/cleanup commands.
- Transactional dependency-closure promotion through a temporary preflight worktree and one squashed primary-checkout commit.
- Best-effort streaming log redaction plus mandatory omission of configured forbidden and tested `.env` paths from result commits and patches.
- Configuration v3 workflow settings and strict task-level dependencies, verification overrides, parallel-safety declarations, and deterministic retry policies.
- Immutable dependency graph and content-derived workflow plans with stable closures, edges, levels, and ready ordering.
- Batch record v1, run record v3 workflow links, independent child reports, separate latest pointers, and corrupt-history-tolerant batch readers.
- Exclusive-by-default scheduling, bounded opt-in concurrency, continue/fail-fast propagation, deterministic retries, and parallel-mutation detection.
- `plan`, `resume`, and `rerun` commands plus batch history/report modes and installed-tarball orchestration scenarios.
- Orchestration architecture, lifecycle, format, CLI, limitation, self-hosting, and ADR documentation.
- Configuration v2 with explicit exec/shell process specs and legacy adapters.
- Run-record v2 with lifecycle checkpoints, structured failures, per-run artifacts, ownership, atomic latest pointers, and v1 readers.
- Bounded streaming process capture, process-tree timeout/interruption cleanup, and stable exit codes.
- Git porcelain-v2 attribution, ignored forbidden-file and symlink evidence, and pure fixed-penalty policies.
- Canonical report model with terminal, JSON, CSV, Markdown, and offline HTML renderers.
- Resilient history loading, expanded doctor checks, task selection, list formats, report selection, and global output flags.
- Clean-build packaging, installed-tarball smoke tests, cross-platform CI, and safe self-hosting fixtures.

### Changed

- The TUI is now a keyboard-first local workflow control surface rather than inspection-only. Coral frames/full-viewport layout, bold Cyan `>` focus, rounded zero-gutter panes, ASCII fallback, and `100/60/40` responsiveness remain unchanged.
- Attached runtime state reconciles from persistence every second, on manual refresh, and on completion; durable records remain authoritative and schemas remain compatible.
- SIGINT/SIGTERM in the TUI request active cancellation and wait a configuration-derived bounded finalization interval before terminal restoration. Confirmed `q` detachment restores immediately and keeps the foreground process alive until completion.
- Plain non-TTY `ariadne init` remains portable and idempotent; `init --yes` opts into detected defaults, while `init --custom` requires an interactive terminal.
- `ariadne init` and maintained examples emit v4. V3 `parallelSafe` tasks adapt to `workspaceMode` with warnings.
- Shared mode remains compatible; mutable tasks are exclusive and read-only mutation fails `workspace.read-only`. Worktree mode permits concurrent mutable tasks in distinct checkouts.
- Worktree retries start fresh from source plus successful dependency results; shared retries retain iterative working-tree behavior.
- `ariadne init` and all maintained examples now emit configuration v3. Versionless, v1, and v2 inputs adapt to dependency-free workflows with warnings.
- `ariadne run` now creates one batch plus one independently persisted run record per task attempt; no-selector execution remains all-tasks compatible.
- Iteration 2 introduced shared-tree `parallelSafe` overlap; v4 adapts that declaration to read-only workspace mode.
- `pnpm check` is the authoritative clean build, test, smoke, and package gate.
- Command-like agent output is warning-only evidence rather than proof of execution.
- Installed-tarball validation now covers pass, agent failure, verification failure, policy failure, dirty baseline, timeout, interruption, corrupt history, renderer agreement, hostile HTML, and latest-pointer behavior.

### Fixed

- Preparation failures now remain `preparation_failed` through batch aggregation, persisted summaries, reports, and exit code 14.
- Ignored paths remain available as repository evidence without making doctor, worktree isolation, primary-checkout guards, or promotion treat an otherwise clean checkout as dirty; real dirty-path diagnostics now list the affected paths.
- Parser-time validation failures for typed CLI options now use the documented usage/configuration exit code 2.
- Resume preserves successful child references, continues attempt numbers, rejects semantic/HEAD drift, and reconciles missing or stale child state without rewriting history.
- Fail-fast cancellation now aborts retry waits, parallel cohorts do not release dependents before overlap safety is known, and batch exit precedence preserves internal failures.
- Batch child references and explicit report inputs are contained within the canonical project root after symlink resolution.
- Batch compatibility status, workflow status, outcome, summary, and fingerprint fields are schema-checked for agreement; planned command arguments are redacted best-effort.
- Removed obsolete trace/report compatibility modules so clean packages contain only reachable runtime modules.
- Doctor now validates a missing run directory through its nearest existing writable ancestor instead of falsely failing before the first run.
- Git evidence is scoped and normalized to the canonical invocation root when Ariadne runs from a nested directory inside a larger repository.
- Timeout cleanup, skipped verification reporting, signal-stage attribution, CSV formula neutralization, unstaged rename attribution, empty forbidden directories, failure sources, untracked deletions, and ignored-directory noise found during release-candidate testing.

### Compatibility

- Versionless/v1/v2/v3 configurations, v1/v2/v3 run records, and v1 batch records remain readable with explicit warnings. Historical records are never migrated in place.

### Known limitations

- Git worktrees isolate repository state only; they do not restrict filesystem permissions, network, external paths, services, caches, environment, or subprocess side effects.
- Shared retries preserve prior repository changes; worktree retries are fresh only with respect to Git checkout state.
- Process and filesystem visibility are evidence-based and incomplete. POSIX cleanup targets the launched process group; detached descendants can escape it. Windows tree cleanup remains best-effort.
- Secret detection/redaction beyond configured forbidden paths and tested `.env` cases is best effort.
