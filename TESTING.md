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
3. `pnpm test` — unit, component, graph/planner, scheduler/retry, resume/rerun, worktree/v2-capture/review/promotion/cleanup, persistence/history/report, Git/policy, and black-box CLI suites.
4. `pnpm test:tui-pty` — uses the POSIX system pseudo-terminal facility when available for selection, planning, launch, live output, detach/reopen, cancellation, resize signaling, and teardown; unsupported platforms retain simulated-TTY coverage.
5. `pnpm smoke` — isolated global-binary installation plus passing and ignored-forbidden-file CLI flows. It uses no-argument `pnpm link` on pnpm 10 and pnpm 11's documented `pnpm add --global .` replacement, always from a disposable staged package.
6. `pnpm test:package` — packs the npm tarball, asserts clean contents and shebang/bin metadata, installs it outside the checkout, and exercises every help screen plus shared/worktree execution, changes/diff/export, clean apply, conflict rollback, idempotent discard, cleanup dry run/execution/history, failures, interruption, resume/rerun, corrupt history, renderer consistency, and latest pointers. The signal case is skipped on Windows because programmatic SIGINT delivery is not portable there.
7. `pnpm test:release` — checks package metadata/license/version consistency, the exact packed allowlist, documentation links, and YAML fence syntax without network access.

The TUI-focused suites cover shared workflow/change/workspace application services, selection/options/confirmation, attention/result/manifest/diff navigation, retry comparison, elevated-risk acknowledgement, apply/discard/export/cleanup flows, runtime event ordering/overflow/failure, redacted UTF-8 streaming, retry/block reduction, fixed-height master/detail and log-dominant compact layouts, list windowing, footer packing, semantic color/ASCII fallbacks, live-output bounds, detach/headless continuation, signal finalization, PTY operation, terminal restoration, and CLI refusal contracts.

Run focused stages while developing:

```sh
pnpm typecheck
pnpm build
pnpm test
pnpm test:tui-pty
pnpm smoke
pnpm test:package
pnpm test:release
pnpm release:profile
pnpm release:check
pnpm dogfood:tui
```

`pnpm release:profile` records point-in-time history, workspace, TUI, wide-workflow, and log scale evidence without enforcing brittle latency thresholds. The 20,000-line diff case remains a deterministic bounded-page test rather than a machine-speed assertion. `pnpm release:check` is the heavyweight candidate gate: it snapshots repository-owned files into a disposable directory, performs a frozen install, runs `pnpm check` twice, runs the profile and production dependency audit, inspects `npm pack --dry-run`, and requires the snapshot to remain clean.

Because black-box CLI tests execute `dist/cli.js`, run `pnpm build` before invoking `pnpm test` directly after source changes. `pnpm check` already guarantees this ordering.

To exercise pnpm 11's global-binary compatibility branch explicitly without changing `packageManager`, run:

```sh
ARIADNE_SMOKE_PNPM_VERSION=11.13.0 pnpm smoke
```

## Acceptance commands

Before release or handoff:

```sh
pnpm check
pnpm check
pnpm release:check
npm pack --dry-run
pnpm test:package
git diff --check
git status --short
```

`npm pack --dry-run` must contain `dist/cli.js`, `README.md`, `LICENSE`, and `package.json`; it must not contain sources, tests, scripts, or stale compiled modules such as the removed `task-validation` files.

## Test organization

- `tests/config-task.test.ts`: schemas, legacy adapters, task discovery, duplicate IDs, doctor checks, containment, and initialization.
- `tests/init-onboarding.test.ts`: repository detection, generated proposals, Custom setup, cancellation, idempotency, replacement diffs, validation, atomic writes, and backups.
- `tests/process-persistence.test.ts`: bounded byte capture, invalid UTF-8, spawn/exit/timeout/interruption, lifecycle checkpoints, attribution, and collisions.
- `tests/policy-git.test.ts`: Git porcelain parsing, dirty baselines, modes/renames/symlinks, glob semantics, command evidence, policies, and scores.
- `tests/report-history.test.ts`: v1 normalization, corruption tolerance, latest pointers, missing artifacts, hostile HTML, CSV, and Markdown escaping.
- `tests/cli-integration.test.ts`: black-box command surface, non-TTY/detected initialization, JSON purity, no-color behavior, and stable exit codes.
- `tests/workflow-graph.test.ts`: graph validation, randomized determinism, selection closure, levels, plan identity, and immutability.
- `tests/workflow-scheduler.test.ts`: exclusivity/concurrency, propagation, retries, parallel mutation, fail-fast, and interruption.
- `tests/workflow-control.test.ts`: resume/rerun compatibility, attempt reuse/numbering, drift rejection, and selection modes.
- `tests/workflow-application.test.ts`: shared inspection/preview/launch handles, cancellation idempotency, registry exclusivity, resume compatibility, and rerun preview modes.
- `tests/workflow-runtime.test.ts`: runtime ordering, replay, per-stream sequences, subscriber backpressure/overflow, terminal-event preservation, and listener failure isolation.
- `tests/workflow-history.test.ts`: atomic batch checkpoints, collisions, corrupt/future/missing-child records, exports, reports, and pointers.
- `tests/isolation-promotion.test.ts`: detached workspace lifecycle, unchanged primary checkout, durable capture, clean promotion, conflict isolation, discard, and preparation failure.
- `tests/change-application.test.ts`: v2 stable change IDs/object metadata, opaque bounded diff pages, binary/sensitive/special-file behavior, no-clobber export and action history, final-attempt eligibility, idempotent discard/v1 promotion normalization, and pure/confirmed cleanup.
- `tests/tui-review.test.tsx`: dashboard attention routing, result review, risk-gated apply, discard confirmation, and cleanup dry-run/execution keyboard flows.
- `tests/tui-services.test.ts`: empty/configless operation, legacy flattening, modern attempts, structured warnings, workspaces, and containment.
- `tests/tui-state-keymap.test.ts`: navigation, contextual keys, filters, refresh generations, stale responses, and scroll state.
- `tests/tui-components.test.tsx`: focus visibility, badges, responsive breakpoints, Unicode/ASCII, monochrome output, and contextual help.
- `tests/tui-operational.test.tsx`: complete keyboard selection/replan/confirm/launch/live-output/cancel-confirmation flow.
- `tests/tui-runtime-state.test.ts`: malformed/duplicate/gapped events, retries, blocked chains, sanitization, partial lines, and 500-line/256 KiB live bounds.
- `tests/tui-sanitize-log.test.ts`: ANSI/OSC/control sanitization, Unicode widths, hostile lines, tail bounds, binary detection, and path safety.
- `tests/tui-terminal.test.ts`: raw-mode/alternate-screen teardown for quit, confirmed headless detach, bounded SIGINT/SIGTERM cancellation, and completion waiting.
- `tests/release-hardening.test.ts`: bounded asynchronous I/O and mixed valid/corrupt history at scale.
- `scripts/tui-pty-smoke.mjs` with `scripts/tui-pty-driver.py`: actual POSIX pseudo-terminal planning, monitoring, detach/reopen, cancellation, resize signal, and restoration when Python's standard-library `pty` module is available.
- `scripts/smoke-test.mjs`: built/global-binary CLI flows without source-checkout mutation.
- `scripts/package-smoke.mjs`: npm package contents, installed binary metadata, external failure/persistence scenarios, renderer agreement, hostile content, and history/latest behavior.
- `scripts/release-contract.mjs`: metadata, license, version, package allowlist, documentation-link, and YAML syntax invariants.
- `scripts/release-profile.mjs`: measured 10/100/1,000/10,000 history, 1,000 workspaces/TUI records, and 4 MiB bounded-log behavior.
- `scripts/tui-dogfood.mjs`: disposable operational/history fixture opened in a real inherited terminal for manual success/failure/retry/blocking/cancellation/detach/signal/resize validation.

Tests use deterministic fake Node agents and disposable repositories. They do not require network access, credentials, or a real coding agent.

## Manual temporary-repository smoke test

```sh
pnpm build
tmpdir="$(mktemp -d)"
git -C "$tmpdir" init
cd "$tmpdir"
node /absolute/path/to/Ariadne/dist/cli.js init
node /absolute/path/to/Ariadne/dist/cli.js doctor
node /absolute/path/to/Ariadne/dist/cli.js plan --all --json > plan.json
node /absolute/path/to/Ariadne/dist/cli.js run --all --isolation worktree --json > batch-summary.json
node /absolute/path/to/Ariadne/dist/cli.js list --batches --format wide
node /absolute/path/to/Ariadne/dist/cli.js report
node /absolute/path/to/Ariadne/dist/cli.js tui
```

Expected artifacts include batch/run records and reports, workspace metadata, change-artifact v2/result refs for non-empty successes, hashed per-file text diffs, all execution latest pointers, and offline child/batch HTML. Promotion commands add separate `.ariadne/promotions/*.json` v2 events; patch export and workspace cleanup add `.ariadne/actions/*.json` v1 events. None replaces latest execution pointers, and cleanup dry runs add no event.

Professional benchmark coverage uses deterministic local fake candidate/judge processes. It validates v5 configuration/tasks before execution; blind, bounded packets; changed/context evidence and exclusions; strict anchor intervals; raw/effective score separation; every failure-policy action; judge failure exit 16; v4/run-record/batch-record adapters; and the guarantee that ordinary `ariadne run` never invokes the judge.

## CI matrix

GitHub Actions runs the same `pnpm check` gate on Ubuntu with Node 20, 22, and 24 and on macOS/Windows with Node 22. Failed jobs pack and upload diagnostic npm artifacts only after the gate fails.

## Debugging failures

- Schema/task errors: use `ariadne doctor --verbose` and inspect stable check IDs.
- Process failures: inspect `agent.stderr.log`, process status, signal, spawn error, timeout, and cleanup metadata.
- Unexpected changes: compare `trace.baseline`, `postPreparation`, `postAgent`, `final`, and attributed change groups.
- Workspace/promotion failures: inspect workspace metadata, `ariadne worktree list`, `ariadne status <run>`, structured conflict/rollback fields, and sanitized recovery commands before manual Git action. A stale preview must be regenerated.
- Policy failures: inspect policy `outcome`, `penalty`, and evidence; do not infer status from score alone.
- History warnings: use `ariadne list --batches` and `ariadne report --batch <id-or-path>` to distinguish corrupt manifests, future versions, and missing children.
- TUI failures: verify stdin/stdout are interactive, the terminal supports raw mode, and `TERM`/locale accurately describe Unicode and color support. Run `pnpm test:tui-pty`, then `pnpm dogfood:tui`; confirm row-one rendering and a last-row footer at 120x30, 80x24, 50x20, and below 40x12. Exercise plan/launch/live output, attention/results/diff, apply cancellation/confirmation/conflict, discard, cleanup dry run/execution, dashboard detach/reopen, headless `q`, Ctrl-C, and SIGTERM. See [troubleshooting](./docs/troubleshooting.md).
- Package failures: inspect `npm pack --json`; the build is intentionally clean so stale `dist` files cannot survive.
