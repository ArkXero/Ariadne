# Run Record v2

The authoritative manifest is `.ariadne/runs/<run-id>/run.json`. `schemaVersion: 2` records a terminal or checkpointed view of one invocation.

## Top-level fields

- `runId`: sortable UTC timestamp plus random suffix.
- `status`: `running`, `completed`, `failed`, `interrupted`, `incomplete`, or reader-derived `abandoned`.
- timestamps and duration.
- Ariadne, Node, platform, release, and architecture metadata.
- owner PID/hostname/start time.
- project root `.` plus relative config and repository metadata.
- normalized, redacted config and legacy compatibility warnings.
- typed lifecycle events, structured failures, task results, summary, and relative artifacts.

## Task result

Each result separates:

- persisted task identity, metadata, prompt SHA-256, and prompt byte length;
- terminal task outcome and lifecycle;
- agent process and verification process results;
- baseline, post-agent, and final repository snapshots;
- preexisting changes and agent/verification attribution;
- forbidden-file and command evidence;
- policy outcomes and score deductions;
- structured failures.

Process output artifacts contain every byte Ariadne captured from the launched process's stdout/stderr pipes until those pipes closed. They cannot include output redirected elsewhere or written after a descriptor is detached. Manifest previews contain head/tail text, captured byte count, UTF-8 replacement mode, and a replacement-detected boolean. Process data distinguishes spawn error, numeric exit, signal, timeout, interruption, and cleanup attempts.

## Paths and privacy

Artifact, config, task, and repository paths are repository-relative POSIX strings. Prompt text and environment values are omitted. Common credential-looking command arguments receive best-effort redaction, but Ariadne is not a secrets vault: users must not place secrets in prompts, filenames, stdout/stderr, diffs, or task metadata.

## Compatibility

Readers accept v1 flat files under `.ariadne/runs/*.json`, normalize their limited data into the report view, label attribution as legacy/unknown, and never mutate them. Malformed and future records return structured errors. `list` skips them with warnings; `report` explains the specific problem. Referenced missing artifacts also become warnings.
