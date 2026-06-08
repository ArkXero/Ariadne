# Testing Ariadne

This guide shows how to verify Ariadne from a fresh checkout and how contributors should check changes before opening a PR.

## Prerequisites

- Node.js 20 or newer
- pnpm 11
- git

Check versions:

```sh
node --version
pnpm --version
git --version
```

## Fresh setup

```sh
pnpm install
```

## Standard checks

Run all project checks:

```sh
pnpm check
```

`pnpm check` runs:

```sh
pnpm typecheck
pnpm build
pnpm test
pnpm smoke
```

Use these individually while developing:

```sh
pnpm typecheck
pnpm build
pnpm test
pnpm test:watch
pnpm smoke
```

## Manual CLI smoke test

Build first:

```sh
pnpm build
```

Run Ariadne in a temporary git repository:

```sh
tmpdir="$(mktemp -d)"
git -C "$tmpdir" init

node "$PWD/dist/cli.js" init --help >/dev/null
node "$PWD/dist/cli.js" --help >/dev/null
node "$PWD/dist/cli.js" -h >/dev/null
node "$PWD/dist/cli.js" -- --help >/dev/null
node "$PWD/dist/cli.js" init
node "$PWD/dist/cli.js" doctor
node "$PWD/dist/cli.js" run
node "$PWD/dist/cli.js" report
```

Expected result:

- `ariadne.yml` exists in temp repo.
- `.ariadne/tasks/example.yml` exists.
- `.ariadne/runs/<timestamp>.json` exists.
- `.ariadne/runs/latest-report.html` exists.
- `.gitignore` contains `/.ariadne/` and `/ariadne.yml`.
- `ariadne doctor` reports no errors.
- Terminal summary reports `failed: 0`.

## Failure smoke test

This verifies Ariadne fails a task when an ignored forbidden file changes.

```sh
tmpdir="$(mktemp -d)"
git -C "$tmpdir" init

node "$PWD/dist/cli.js" init
printf ".env\n" >> "$tmpdir/.gitignore"
perl -0pi -e 's/command: "cat"/command: "sh -c '\''cat > .env'\''"/' "$tmpdir/ariadne.yml"

set +e
node "$PWD/dist/cli.js" run
exit_code=$?
set -e

node "$PWD/dist/cli.js" report
test "$exit_code" -eq 1
```

Expected result:

- `ariadne run` exits `1`.
- Report shows task failed.
- Report includes `Forbidden file changes: .env`.

## Developer workflow

Before code changes:

```sh
git status --short
```

During implementation:

```sh
pnpm typecheck
```

Before handoff or PR:

```sh
pnpm check
git status --short
```

## What to inspect when a check fails

- Type errors: inspect affected source file and exported types in `src/types/index.ts`.
- Build errors: confirm imports use ESM `.js` suffix for local TypeScript files.
- Smoke failure on `run`: inspect latest `.ariadne/runs/<timestamp>.json` in printed temp directory.
- Report failure: inspect `.ariadne/runs/latest-report.html` in printed temp directory.
- Unexpected changed-file failures: compare `trace.changedFiles`, `trace.workspaceDirtyBefore`, and `trace.diff`.
- Forbidden file failures: compare `trace.forbiddenFileChanges` with `checks.forbidden_files`.

## Current test coverage

Current MVP uses:

- TypeScript compiler checks.
- Build check.
- Vitest unit tests for config loading, doctor diagnostics, task loading, scorer behavior, git helpers, and forbidden-file snapshots.
- Smoke test for passing init/run/report.
- Smoke test for forbidden ignored file failure.
