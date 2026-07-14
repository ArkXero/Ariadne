# Changelog

## Unreleased

### Added

- Configuration v2 with explicit exec/shell process specs and legacy adapters.
- Run-record v2 with lifecycle checkpoints, structured failures, per-run artifacts, ownership, atomic latest pointers, and v1 readers.
- Bounded streaming process capture, process-tree timeout/interruption cleanup, and stable exit codes.
- Git porcelain-v2 attribution, ignored forbidden-file and symlink evidence, and pure fixed-penalty policies.
- Canonical report model with terminal, JSON, CSV, Markdown, and offline HTML renderers.
- Resilient history loading, expanded doctor checks, task selection, list formats, report selection, and global output flags.
- Clean-build packaging, installed-tarball smoke tests, cross-platform CI, and safe self-hosting fixtures.

### Changed

- `ariadne init` and all maintained examples now emit configuration v2.
- `pnpm check` is the authoritative clean build, test, smoke, and package gate.
- Command-like agent output is warning-only evidence rather than proof of execution.
- Installed-tarball validation now covers pass, agent failure, verification failure, policy failure, dirty baseline, timeout, interruption, corrupt history, renderer agreement, hostile HTML, and latest-pointer behavior.

### Fixed

- Doctor now validates a missing run directory through its nearest existing writable ancestor instead of falsely failing before the first run.
- Git evidence is scoped and normalized to the canonical invocation root when Ariadne runs from a nested directory inside a larger repository.
- Timeout cleanup, skipped verification reporting, signal-stage attribution, CSV formula neutralization, unstaged rename attribution, empty forbidden directories, failure sources, untracked deletions, and ignored-directory noise found during release-candidate testing.

### Compatibility

- Versionless/v1 configurations and v1 run records remain readable with explicit warnings.

### Known limitations

- Execution remains serial in one working tree; Ariadne is not a sandbox or filesystem-isolation layer.
- Process and filesystem visibility are evidence-based and incomplete. POSIX cleanup targets the launched process group; detached descendants can escape it. Windows tree cleanup remains best-effort.
- Output artifacts, diffs, filenames, and metadata can contain secrets even though common secret-looking command arguments are redacted best-effort.
