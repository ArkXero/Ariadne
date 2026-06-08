# AGENTS.md

Guidance for AI coding agents and human contributors working on Ariadne.

## Project purpose

Ariadne is a local-first developer tool for evaluating AI coding-agent reliability. It provides a Node.js CLI that runs eval tasks, captures traces, scores behavior, and generates reliability reports.

Keep the MVP focused:

- Local CLI first.
- GitHub Action support can build on the CLI later.
- No SaaS auth, hosted dashboards, teams, billing, or database until explicitly requested.
- Prefer transparent trace JSON over hidden state.

## Tech stack

- TypeScript
- Node.js ESM
- pnpm
- commander for CLI commands
- zod for config validation
- yaml for YAML parsing
- execa for shell commands
- fs-extra for filesystem helpers
- minimatch for file pattern checks

## Commands

Use pnpm.

```sh
pnpm install
pnpm typecheck
pnpm build
pnpm dev --help
pnpm ariadne --help
pnpm ariadne -h
```

For local smoke tests after `pnpm build`:

```sh
node dist/cli.js init
node dist/cli.js doctor
node dist/cli.js run
node dist/cli.js report
```

Prefer running smoke tests in a temporary git repo so generated `.ariadne/` files do not pollute this repository.

## Repository map

- `src/cli.ts`: CLI entrypoint and command wiring.
- `src/commands/`: thin command handlers.
- `src/core/config.ts`: `ariadne.yml` loading and validation.
- `src/core/task-loader.ts`: task YAML discovery and validation.
- `src/core/doctor.ts`: pre-run config, task, executable, and package script diagnostics.
- `src/core/runner.ts`: task execution, verification, trace capture, run JSON writing.
- `src/core/scorer.ts`: pass/fail scoring checks.
- `src/core/git.ts`: git status and diff helpers.
- `src/core/forbidden-files.ts`: forbidden file snapshot checks, including ignored files.
- `src/core/report.ts`: terminal and HTML report generation.
- `src/types/index.ts`: shared TypeScript interfaces.

Keep commands thin. Put behavior in `src/core/`.

## Coding rules

- Read relevant files before editing.
- Make minimal, targeted changes.
- Preserve public config and task shapes unless request requires changes.
- Keep local-only behavior as default.
- Do not add dependencies unless there is clear value.
- Do not introduce frameworks, servers, databases, queues, auth, telemetry, or hosted services for MVP work.
- Keep generated report output deterministic enough to test.
- Prefer explicit typed data over ad hoc strings.
- Keep CLI errors actionable.

## Runner behavior

`ariadne run` should:

- Read `ariadne.yml`.
- Load task YAML files from configured tasks directory.
- Send each task prompt to `agent.command` through stdin.
- Expose task data with `ARIADNE_TASK_ID`, `ARIADNE_TASK_NAME`, `ARIADNE_TASK_FILE`, and `ARIADNE_TASK_PROMPT`.
- Capture stdout, stderr, exit code, runtime, changed files, git diff, diff line count, and observed commands where possible.
- Run configured verification commands.
- Score every task.
- Write one useful JSON trace per run to `.ariadne/runs/<timestamp>.json`.

Tasks must fail when:

- Agent command exits nonzero.
- Verification command exits nonzero.
- Forbidden files change.
- Changed file count exceeds `checks.max_changed_files`.
- Diff line count exceeds `checks.max_diff_lines`.
- Forbidden command strings appear in logs or observed commands.

Forbidden file checks should catch ignored files such as `.env`, not only files visible to git status.

## Report behavior

`ariadne report` should:

- Read latest run JSON by default.
- Print concise terminal summary.
- Generate `.ariadne/runs/latest-report.html`.
- Include enough detail to debug failures without opening raw JSON first.

## Verification expectations

Before finishing code changes, run the narrowest useful checks:

```sh
pnpm typecheck
pnpm build
```

For full project verification, use:

```sh
pnpm check
```

See `TESTING.md` for the developer-facing test plan and expected results.

For CLI behavior changes, also run a temp-repo smoke test:

```sh
pnpm smoke
```

If verification cannot run, state why.

## Git hygiene

- Check `git status --short` before editing.
- Do not overwrite or revert user work.
- Do not commit unless explicitly asked.
- `ariadne init` adds `/.ariadne/` and `/ariadne.yml` to host-project `.gitignore`.
- Keep `dist/` and `node_modules/` out of git.
- Do not store secrets in config examples, tasks, reports, or snapshots.

## Contributor notes

Good changes for this stage:

- Stronger schemas and clearer validation errors.
- Better trace JSON.
- Focused scorer improvements.
- Small report improvements.
- Tests around config loading, task loading, scoring, and report generation.
- GitHub Action wrapper that shells out to CLI without changing local-first core.

Avoid for now:

- Hosted dashboards.
- SaaS account models.
- Billing and teams.
- Database-backed runs.
- Long-running daemon processes.
- Broad rewrites of CLI architecture.
