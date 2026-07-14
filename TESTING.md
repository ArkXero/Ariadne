# Testing Ariadne

## Prerequisites

- Node.js 20 or newer
- pnpm 10.34.1
- Git

```sh
node --version
pnpm --version
git --version
pnpm install --frozen-lockfile
```

## Authoritative gate

```sh
pnpm check
```

The gate runs, in order:

1. `pnpm lint` — TypeScript no-emit validation.
2. `pnpm build` — deletes `dist`, then compiles TypeScript.
3. `pnpm test` — unit, component, persistence, history/report, Git/policy, and black-box CLI integration suites.
4. `pnpm smoke` — isolated global-binary installation plus passing and ignored-forbidden-file CLI flows. It uses no-argument `pnpm link` on pnpm 10 and pnpm 11's documented `pnpm add --global .` replacement, always from a disposable staged package.
5. `pnpm test:package` — packs the npm tarball, asserts clean contents and shebang/bin metadata, installs it outside the checkout, and exercises every help screen plus pass, agent-failure, verification-failure, policy-failure, dirty-baseline, timeout, interruption, corrupt-history, renderer-consistency, and latest-pointer flows. The signal case is skipped on Windows because programmatic SIGINT delivery is not portable there.

Run focused stages while developing:

```sh
pnpm typecheck
pnpm build
pnpm test
pnpm smoke
pnpm test:package
```

Because black-box CLI tests execute `dist/cli.js`, run `pnpm build` before invoking `pnpm test` directly after source changes. `pnpm check` already guarantees this ordering.

To exercise pnpm 11's global-binary compatibility branch explicitly without changing `packageManager`, run:

```sh
ARIADNE_SMOKE_PNPM_VERSION=11.13.0 pnpm smoke
```

## Acceptance commands

Before release or handoff:

```sh
pnpm check
npm pack --dry-run
pnpm test:package
git diff --check
git status --short
```

`npm pack --dry-run` must contain `dist/cli.js`, `README.md`, `LICENSE`, and `package.json`; it must not contain sources, tests, scripts, or stale compiled modules such as the removed `task-validation` files.

## Test organization

- `tests/config-task.test.ts`: schemas, legacy adapters, task discovery, duplicate IDs, doctor checks, containment, and initialization.
- `tests/process-persistence.test.ts`: bounded byte capture, invalid UTF-8, spawn/exit/timeout/interruption, lifecycle checkpoints, attribution, and collisions.
- `tests/policy-git.test.ts`: Git porcelain parsing, dirty baselines, modes/renames/symlinks, glob semantics, command evidence, policies, and scores.
- `tests/report-history.test.ts`: v1 normalization, corruption tolerance, latest pointers, missing artifacts, hostile HTML, CSV, and Markdown escaping.
- `tests/cli-integration.test.ts`: black-box command surface, JSON purity, no-color behavior, and stable exit codes.
- `scripts/smoke-test.mjs`: built/global-binary CLI flows without source-checkout mutation.
- `scripts/package-smoke.mjs`: npm package contents, installed binary metadata, external failure/persistence scenarios, renderer agreement, hostile content, and history/latest behavior.

Tests use deterministic fake Node agents and disposable repositories. They do not require network access, credentials, or a real coding agent.

## Manual temporary-repository smoke test

```sh
pnpm build
tmpdir="$(mktemp -d)"
git -C "$tmpdir" init
cd "$tmpdir"
node /absolute/path/to/Ariadne/dist/cli.js init
node /absolute/path/to/Ariadne/dist/cli.js doctor
node /absolute/path/to/Ariadne/dist/cli.js run --json > run-summary.json
node /absolute/path/to/Ariadne/dist/cli.js list --format wide
node /absolute/path/to/Ariadne/dist/cli.js report
```

Expected artifacts are `.ariadne/runs/<run-id>/run.json`, per-process logs, `repository.diff`, `report.html`, `.ariadne/runs/latest.json`, and `.ariadne/runs/latest-report.html`.

## CI matrix

GitHub Actions runs the same `pnpm check` gate on Ubuntu with Node 20, 22, and 24 and on macOS/Windows with Node 22. Failed jobs pack and upload diagnostic npm artifacts only after the gate fails.

## Debugging failures

- Schema/task errors: use `ariadne doctor --verbose` and inspect stable check IDs.
- Process failures: inspect `agent.stderr.log`, process status, signal, spawn error, timeout, and cleanup metadata.
- Unexpected changes: compare `trace.baseline`, `postAgent`, `final`, and `taskChanges`.
- Policy failures: inspect policy `outcome`, `penalty`, and evidence; do not infer status from score alone.
- History warnings: use `ariadne report --run <id-or-path>` to distinguish corrupt manifests, future versions, and missing artifacts.
- Package failures: inspect `npm pack --json`; the build is intentionally clean so stale `dist` files cannot survive.
