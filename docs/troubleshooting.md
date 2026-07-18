# Troubleshooting

## TUI does not start

`ariadne tui` requires interactive stdin/stdout and raw-mode support. Run it directly in a terminal, not through a pipe. `--json` and `--quiet` are intentionally rejected. For framing or character problems, verify `TERM` and a UTF-8 locale; use `--no-color` or `NO_COLOR=1` for monochrome and `TERM=dumb` to exercise ASCII fallback.

## A workflow says no active runtime attached

The record is durable but this Ariadne process does not own its live handle. This is expected after restart or for workflows launched by another process. Inspect the record and artifacts, then use resume or rerun after reviewing the preview. Ariadne does not claim operating-system process reattachment.

## Live output is truncated or shows a sequence gap

The UI retains only 500 lines and 256 KiB per run/process/stream. Subscriber queues retain 512 events and 1 MiB of output. Old output is dropped before terminal state and the TUI shows `[earlier output truncated]` or a sequence-gap warning. Read the complete safe project-relative artifact path from task/attempt detail.

## Cancellation appears slow

Cancellation stops launches, removes retry waits, asks active process groups to terminate, then persists task and batch state. Cleanup waits for `termination_grace_ms` before best-effort force termination. External SIGINT/SIGTERM waits at most `min(30s, 2 * termination_grace_ms + 5s)` before restoring the terminal. Detached descendants can still escape the process group; see [known limitations](./known-limitations.md).

## The shell remains occupied after detach

Confirmed `q` detach restores the screen but continues the workflow headlessly in the same foreground Ariadne process. It is not a daemon. Wait for completion or press Ctrl-C to request cancellation.

## Terminal state looks damaged

Run `reset` or `stty sane`, then reproduce with `pnpm test:tui-pty` and `pnpm dogfood:tui`. Report the terminal emulator, OS, `TERM`, locale, dimensions, whether the path was normal quit/detach/SIGINT/SIGTERM/render failure, and whether `\e[?1049l` restoration appeared in captured output.

## Apply says the preview is stale

The target branch, HEAD, repository identity, or result closure changed after preview. Ariadne did not apply against the new state. Return to the result, run `a`, repeat eligibility and preflight, review the new fingerprint inputs, and confirm again. Do not treat an earlier clean preflight as current.

## Apply reports a conflict

Preflight conflicts occur only in an Ariadne temporary worktree and leave the primary checkout unchanged. An unexpected primary-checkout conflict triggers `git cherry-pick --abort` plus HEAD/operation-state verification. If the result screen says manual recovery is required, run only the sanitized commands shown there after inspecting `git status --short --branch`; Ariadne deliberately has no merge editor or automatic resolution.

## A diff is metadata-only or truncated

Binary, sensitive, oversized (over 8 MiB), or over-1,000-hunk file diffs are metadata-only. Other pages read at most 64 KiB and return at most 400 lines. Use `e` for a unique no-clobber safe patch export, or `ariadne diff <run> --output <path>`; the CLI requires `--force` to replace an existing destination.

## Workspace cleanup skips a resource

Inspect workspace detail for repository-ID, `ws-` name, exact managed path, owner, state, directory/registration, symlink, or corruption blockers. Dry runs never change the resource. Do not manually broaden the cleanup path; unknown or unprovable directories are intentionally skipped. Missing managed directories can be cleaned idempotently, while partial failures remain available for retry.
