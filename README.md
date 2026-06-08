# Ariadne

Ariadne is a local CLI for running coding-agent reliability evals. It executes task prompts against a configured agent command, captures traces, scores behavior, and writes JSON plus HTML reports.

## Install

```sh
pnpm install
pnpm build
```

## Commands

```sh
pnpm ariadne --help
pnpm ariadne -h
pnpm ariadne init
pnpm ariadne doctor
pnpm ariadne run
pnpm ariadne list
pnpm ariadne report
```

`pnpm ariadne -- --help` also works for compatibility with package-manager argument separator usage.

## Checks

```sh
pnpm check
```

See [TESTING.md](./TESTING.md) for full setup, smoke tests, expected results, and failure-debugging notes.

During development, use:

```sh
pnpm dev init
pnpm dev doctor
pnpm dev run
pnpm dev list
pnpm dev report
```

## Workflow

`ariadne init` creates:

- `ariadne.yml`
- `.ariadne/tasks/example.yml`
- `.ariadne/runs/`
- `.gitignore` entries for `/.ariadne/` and `/ariadne.yml`

The ignore entries keep Ariadne config, tasks, and generated run artifacts out of host-project git status and formatter checks. Running `ariadne init` again updates existing projects without duplicating entries.

For Codex, set `agent.command` to read Ariadne's stdin prompt explicitly:

```yaml
agent:
  command: "codex exec --sandbox workspace-write -"
```

`ariadne run` reads `ariadne.yml`, loads YAML tasks, sends each task prompt to `agent.command` via stdin, runs configured verification commands, captures git traces, scores checks, and writes `.ariadne/runs/<timestamp>.json`.

`ariadne doctor` validates config and task files, checks command executables, and detects missing package manager scripts before a run.

`ariadne list` prints every run in the project, newest first, with status, task, duration, and JSON path.

To also generate a CSV snapshot when `ariadne list` runs, enable it in `ariadne.yml`:

```yaml
list:
  csv:
    enabled: true
    path: ".ariadne/runs/runs.csv"
```

`ariadne report` reads the latest run JSON, prints a terminal summary, and writes `.ariadne/runs/latest-report.html`.

## MVP checks

- Agent command must exit with code 0.
- Verification commands must pass.
- Forbidden files must not be modified.
- Changed files must not exceed `checks.max_changed_files`.
- Diff lines must not exceed `checks.max_diff_lines`.
- Forbidden command strings must not appear in logs or observed commands.
