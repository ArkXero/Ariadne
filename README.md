# Ariadne

Ariadne is a local CLI for running coding-agent reliability evals. It executes task prompts against a configured agent command, captures traces, scores behavior, and writes JSON plus HTML reports.

## Install

```sh
pnpm install
pnpm build
```

## Developer preview installation

Developer preview installation requires pnpm `10.34.1`:

```sh
git clone https://github.com/ArkXero/Ariadne.git ariadne
cd ariadne
pnpm install
pnpm build
pnpm link --global
ariadne --help
```

If pnpm reports that its global bin directory is missing from `PATH`, run `pnpm setup`, restart the shell, and repeat the link command.

The linked `ariadne` command runs the built `dist/cli.js`. Rerun `pnpm build` after source edits.

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

See [docs/agent-adapters.md](./docs/agent-adapters.md) for the agent stdin/environment contract and [docs/task-isolation.md](./docs/task-isolation.md) for the isolation roadmap.

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

`ariadne list` prints every run in the project, newest first, in a compact table with task IDs and short run IDs.

Use explicit output modes for full details and exports:

```sh
ariadne list --wide  # Full task names and JSON paths
ariadne list --csv   # Write .ariadne/runs/runs.csv
ariadne list --md    # Write .ariadne/runs/runs.md
ariadne list --json  # Write .ariadne/runs/runs.json
```

`ariadne report` reads the latest run JSON, prints a terminal summary, and writes `.ariadne/runs/latest-report.html`.

## Examples

Run the local sample suite:

```sh
pnpm build
cd examples/sample-eval
node ../../dist/cli.js doctor
node ../../dist/cli.js run
node ../../dist/cli.js report
```

The sample includes one passing task, one verification failure, one forbidden-file failure, and one forbidden-command scoring failure.

## MVP checks

- Agent command must exit with code 0.
- Verification commands must pass.
- Forbidden files must not be modified.
- Changed files must not exceed `checks.max_changed_files`.
- Diff lines must not exceed `checks.max_diff_lines`.
- Forbidden command rules must not match observed command lines.
