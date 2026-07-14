# Architecture

Ariadne is a local Node.js ESM CLI. Commands remain thin; core modules own validation, execution, evidence, persistence, aggregation, and rendering.

## Data flow

1. `src/cli.ts` parses global and command options and routes stdout/stderr.
2. `src/core/config.ts` parses YAML, performs strict versioned structural validation, applies defaults, runs semantic/path checks, resolves the canonical root, and returns a deeply frozen normalized v2 config.
3. `src/core/task-loader.ts` discovers strict task YAML files, validates path-safe IDs, and rejects case-insensitive duplicates.
4. `src/core/runner.ts` creates a run directory before execution, checkpoints lifecycle transitions, runs selected tasks serially, and finalizes exactly once.
5. `src/core/process-runner.ts` launches direct or explicit-shell processes, streams raw output artifacts, retains bounded previews, and coordinates timeout/interruption cleanup.
6. `src/core/git.ts` captures Git porcelain-v2/NUL snapshots; `forbidden-files.ts` independently fingerprints forbidden paths including ignored files and symlinks.
7. `src/core/scorer.ts` evaluates four pure policies and produces the only score breakdown.
8. `src/core/persistence.ts` validates and atomically writes v2 manifests and terminal latest pointers.
9. `src/core/run-reader.ts` loads v2 or legacy v1 records into structured success/failure unions and tolerates corrupt history.
10. `src/core/report.ts` builds the canonical report view consumed by terminal, JSON, list, CSV, Markdown, and offline HTML renderers.

## Boundaries

- Commands do not recalculate outcome or score.
- Renderers consume canonical values; they do not inspect raw traces to derive status.
- The config adapter is the only place legacy command strings become v2 process specs.
- Historical records are read through adapters and never rewritten.
- Repository-relative paths are persisted; the project root is represented as `.`.
- Prompts and environment values are intentionally excluded from manifests.

## Determinism and recovery

Task ordering, policy ordering, deductions, history ordering, and exports are stable. Each run ID combines a sortable UTC timestamp with random collision resistance, and exclusive directory creation prevents overwrite. Checkpoints make partial progress visible. Same-host running manifests whose owner PID is dead are presented as abandoned. A valid terminal manifest precedes any `latest.json` update.

## Non-goals

This iteration does not add a server, database, authentication, telemetry, hosted dashboard, filesystem isolation, parallel mutation, or a claim of OS-level sandboxing.
