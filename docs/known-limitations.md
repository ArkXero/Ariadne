# Known Limitations

## Ariadne TUI

- The TUI is keyboard-first and can plan, launch, monitor, review, apply, discard, export, inspect/clean workspaces, cancel, resume, and rerun. Remote execution and mouse-first behavior remain out of scope.
- Alternate-screen, raw-mode, color-depth, and Unicode behavior depend on the terminal emulator. `TERM=dumb` and non-UTF-8 locales receive ASCII frames and separators; `--no-color` or `NO_COLOR` removes styled text.
- Terminals smaller than 40 columns or 12 rows show a recoverable minimum-size screen. Resize to inspect history.
- Attached workflows reconcile provisional runtime events with authoritative persistence every second and on `r`. History from other processes is readable, but Ariadne does not reattach to their operating-system processes after restart.
- Runtime events are in-memory responsiveness hints. Slow subscribers may lose old output and receive a sequence-gap warning; full output remains only in artifact files.
- Only one active batch is permitted per TUI process. Confirmed `q` detachment is headless continuation in the same foreground process, not a daemon; the shell remains occupied.
- Log previews load only the final 64 KiB, discard an initial partial line, sanitize terminal controls, and refuse binary-looking, unreadable, missing, or project-external paths. Full artifacts remain available by their safe project-relative paths.
- Change-diff browsing is intentionally bounded: v2 artifacts stop at 8 MiB or 1,000 hunks and viewer requests return at most 64 KiB/400 lines. V1 browsing falls back to its historical bounded whole-result preview. Search is not implemented; use safe patch export for the complete captured patch.
- Screen-reader behavior depends on Ink and the terminal. Plain status labels and monochrome mode preserve meaning, but interactive terminal accessibility varies by platform.

## Execution, concurrency, and retries

- Shared mode runs tasks in the canonical invocation tree. Mutable tasks are exclusive; read-only declarations are policy assertions, not permissions.
- Worktree mode isolates Git repository state in detached checkouts. It does not isolate operating-system permissions, network, services, caches, external paths, environment, credentials, or arbitrary subprocess side effects.
- Git-visible mutation during an overlapping cohort is failed conservatively, but ignored paths, external destinations, network effects, and changes hidden from Git can escape detection.
- Shared retries are iterative. Worktree retries use a fresh checkout from the original source plus successful dependency results, but external/cache state can still persist.
- Resume requires the same semantic fingerprint, source revision, and surviving result refs, but cannot prove external dependencies are unchanged.
- Ariadne does not isolate filesystem, network, credentials, environment, or operating-system capabilities. It is not a sandbox.

## Process visibility and cleanup

- Ariadne knows configured agent and verification processes. Command-like output is reported evidence, not proof of execution.
- It does not audit syscalls, subprocess creation, network activity, terminal replay, or commands hidden inside another program.
- POSIX cleanup targets the launched process group with TERM then KILL. Descendants that create a different session/group can escape.
- Windows `taskkill /T` and `/F` are best-effort and cannot prove every descendant stopped.
- A second SIGINT/SIGTERM exits immediately, so deliberate escalation can bypass final persistence.

## Filesystem and Git evidence

- Git snapshots describe the active shared or managed checkout, not arbitrary machine paths.
- Dedicated forbidden-file matching inspects configured ignored paths, but Ariadne does not inventory every ignored file by default.
- Symlink evidence fingerprints link target strings without following external targets.
- Non-Git execution cannot provide changed-file or diff-line attribution and is rejected when those policies require it.

## Output and secrets

- Artifacts contain captured pipe bytes; redirected or detached output is invisible.
- Manifests retain bounded head/tail previews, so omitted middle output is unavailable as evidence.
- Configured forbidden paths and tested `.env` cases are omitted from safe result artifacts. Other filename/content detection and streaming redaction are best effort; secrets can still escape through unrecognized files, encodings, external output, or metadata.

## Promotion

- Apply supports only the same Git repository, a clean named branch, and surviving Ariadne result commits. It performs no stash, automatic merge, push, or remote operation.
- Preflight catches Git cherry-pick conflicts visible in the temporary worktree. External side effects and platform-specific mode/symlink behavior remain outside the transaction.
- Conflict preflight is an estimate, not a guarantee. There is no merge editor, interactive conflict resolution, or automatic merge.
- An unexpected real-checkout conflict is aborted and verified best effort. Ariadne refuses unrelated/incompletely owned Git operations rather than assuming recovery authority. Rollback verification failure requires the displayed manual recovery commands.
- Discard deletes managed refs and retained worktrees, not immutable manifests, reports, safe patches, Git reflogs, or immediately unreachable Git objects.
- Binary content is metadata-only. Exported patches can differ operationally from Git-native result-ref promotion, especially for binary, symlink, executable-mode, rename/copy, and platform-dependent behavior.
- Secret detection is best effort beyond configured forbidden paths and tested high-confidence filenames. Sensitive-path omission prevents known content from diff/export artifacts but cannot classify every secret.

## Historical records

- Legacy v1/v2/v3 runs and v1 batches remain readable, but absent isolation/promotion data is labeled unavailable rather than reconstructed.
- Abandonment detection only identifies a dead same-host PID. It does not prove why execution stopped or reconcile filesystem mutations.
- Corrupt batches and missing children are reported as warnings; repair is manual or performed through a new resume/rerun batch, never by mutating history.
