# Ariadne

Ariadne is a local CLI for running coding-agent reliability evals. It executes task prompts against a configured agent command, captures traces, scores behavior, and writes JSON plus HTML reports.

## Install

```sh
pnpm install
pnpm build
```

## Commands

```sh
pnpm ariadne init
pnpm ariadne run
pnpm ariadne report
```

## Checks

```sh
pnpm check
```

See [TESTING.md](./TESTING.md) for full setup, smoke tests, expected results, and failure-debugging notes.

During development, use:

```sh
pnpm dev init
pnpm dev run
pnpm dev report
```

## Workflow

`ariadne init` creates:

- `ariadne.yml`
- `.ariadne/tasks/example.yml`
- `.ariadne/runs/`

For Codex, set `agent.command` to read Ariadne's stdin prompt explicitly:

```yaml
agent:
  command: "codex exec --sandbox workspace-write -"
```

`ariadne run` reads `ariadne.yml`, loads YAML tasks, sends each task prompt to `agent.command` via stdin, runs configured verification commands, captures git traces, scores checks, and writes `.ariadne/runs/<timestamp>.json`.

`ariadne report` reads the latest run JSON, prints a terminal summary, and writes `.ariadne/runs/latest-report.html`.

## MVP checks

- Agent command must exit with code 0.
- Verification commands must pass.
- Forbidden files must not be modified.
- Changed files must not exceed `checks.max_changed_files`.
- Diff lines must not exceed `checks.max_diff_lines`.
- Forbidden command strings must not appear in logs or observed commands.
