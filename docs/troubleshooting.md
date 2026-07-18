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
