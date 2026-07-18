# CLI Contract

## Global options

- `--verbose`: include stack traces and deeper diagnostics.
- `--quiet`: suppress progress and warning output.
- `--json`: emit a machine-readable JSON payload.
- `--no-color`: disable color and styled text. The interactive TUI still uses terminal control sequences for raw-mode screen management.

`--verbose` and `--quiet` conflict. Machine modes write only payloads to stdout; progress, warnings, and artifact locations go to stderr.

## Commands

```text
ariadne init [--yes|--custom]
ariadne doctor [--config <path>]
ariadne plan [task-id...] [--all] [--concurrency <n>] [--failure-mode continue|fail-fast] [--isolation shared|worktree] [--allow-dirty-base]
ariadne run [task-id...] [--task <id>]... [--all] [--concurrency <n>] [--failure-mode continue|fail-fast] [--isolation shared|worktree] [--allow-dirty-base]
ariadne resume <batch-id-or-path> [--concurrency <n>] [--allow-dirty-base]
ariadne rerun <batch-id-or-path> (--failed|--blocked|--all|--task <id>...) [--isolation shared|worktree] [--allow-dirty-base]
ariadne list [--tasks|--batches] [--unapplied|--applied|--discarded] [--format compact|wide|json|csv|markdown] [--output <path>]
ariadne report [--run <id-or-path>|--batch <id-or-path>] [--output <path>]
ariadne tui
ariadne changes <run-id-or-path>
ariadne diff <run-id-or-path> [--output <path>]
ariadne status <run-id-or-path>
ariadne apply <run-id-or-path>
ariadne discard <run-id-or-path>
ariadne worktree list
ariadne worktree remove <workspace-id>
ariadne worktree clean [--dry-run]
```

Interactive `init` starts with Default versus Custom setup. Default is repository-aware; Custom covers the agent, imported script tasks, dependencies, isolation, concurrency, retries, file protections, limits, and timeout before a YAML/file-change review. Ctrl-C or Cancel at a prompt exits before writes.

`--yes` accepts detected defaults without prompting. `--custom` requires an interactive terminal. Plain non-TTY `init` retains the portable example configuration for automation. If `ariadne.yml` already exists, non-TTY initialization changes nothing. Interactive replacement requires a diff review, validates the proposed v4 config in a disposable directory, writes an `ariadne.yml.backup-*` file, and atomically replaces the config; existing task files are skipped rather than overwritten.

`plan` and `run` with no selectors include all tasks. Positional IDs and repeatable `run --task` values are merged and deduplicated case-insensitively. `--all` conflicts with explicit IDs. Selecting a task includes its transitive dependency closure. The first human-readable `plan` in a project includes a field guide and records that it was shown under `.ariadne/onboarding/`; `--quiet` and `--json` never show or record the guide. `plan` launches nothing and creates no execution records.

`resume` retains source isolation and requires the source semantic fingerprint and Git HEAD. Only concurrency and dirty-base acknowledgement can change. Successful child/result references are reused; missing refs and uncertain workspaces are requeued in fresh worktrees.

`rerun` requires exactly one selection mode. It uses current validated configuration, reruns the selected roots and their current dependency closure, and never reuses successful child attempts.

`list` defaults to task-attempt history. `--wide`, `--csv`, `--md`, and global `--json` remain format aliases. Conflicting kinds/formats fail with exit 2. `report` follows `.ariadne/latest.json` by default. Input and output paths must remain inside the canonical project root after symlink resolution.

`tui` requires interactive stdin/stdout and stdin raw-mode support. Non-TTY use exits 2 with empty stdout and plain stderr. `--json` and `--quiet` are rejected. `--verbose`, `--no-color`, `NO_COLOR`, limited-color terminals, terminal resizing, SIGINT, and SIGTERM are supported. Missing configuration and empty history open a safe dashboard.

The TUI uses the same application service as `plan`, `run`, `resume`, and `rerun`. It can select roots, inspect dependency expansion, edit concurrency `1..32`, failure mode, isolation, and dirty-base acknowledgement, explicitly launch one attached workflow, stream provisional redacted process events, request idempotent cancellation, and create new related resume/rerun history after confirmation. Persisted records remain authoritative and source batches are immutable. A running/incomplete record without a current-process registry handle is inspection-only and labeled `no active runtime attached`; restart-time process reattachment is not claimed. Apply, discard, worktree cleanup, remote execution, and schema migration remain CLI-only.

With no active workflow, `q` exits immediately. With an active workflow, `q` requires confirmation, restores the terminal, and leaves the shell occupied until the same Ariadne process finishes headless execution. Ctrl-C after detachment requests cancellation. SIGINT/SIGTERM request cancellation, wait up to `min(30s, 2 * termination_grace_ms + 5s)`, restore the terminal, and report signal exit code 130/143.

`diff` prints only the bounded text-safe preview unless `--output` explicitly copies the complete safe binary patch. `apply` never stashes or merges automatically. Preflight conflicts do not touch the primary checkout; an unexpected primary cherry-pick conflict is aborted. Management commands write separate promotion records and do not replace execution latest pointers.

## Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | Success |
| 2 | Usage or configuration failure |
| 3 | Task/batch selection failure |
| 4 | Repository precondition failure |
| 10 | Agent spawn/nonzero failure |
| 11 | Agent or verification timeout |
| 12 | Verification failure |
| 13 | Policy or parallel-safety failure |
| 14 | Workspace creation or preparation failure |
| 15 | Promotion precondition or conflict |
| 70 | Internal or persistence failure |
| 130 | SIGINT |
| 143 | SIGTERM |

Mixed final outcomes use interruption, internal failure, timeout, agent failure, verification failure, policy failure, then success. Failed attempts superseded by a successful retry do not determine the exit code. Blocked tasks inherit their causal failure. A detected parallel-safety violation exits 13.
