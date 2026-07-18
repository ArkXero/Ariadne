# Release Process

## Prerequisites

- Node.js 20 or newer, pnpm 10.34.1 through Corepack, and Git.
- A named branch with only reviewed release changes. Generated `dist`, `node_modules`, tarballs, histories, logs, screenshots, credentials, and temporary worktrees must remain ignored and outside the package.
- An updated Unreleased changelog. Confirm the intended version separately; the release gate never changes it.
- Green supported CI: Ubuntu on Node 20, 22, and 24 plus macOS and Windows on Node 22.

## Candidate verification

Run the heavyweight local gate:

```sh
pnpm release:check
```

It copies only Git-owned files into a disposable path, commits that snapshot locally, performs `pnpm install --frozen-lockfile`, runs `pnpm check` twice, records bounded-resource measurements, runs `pnpm audit --prod`, executes `npm pack --dry-run`, checks whitespace, and fails if repository-owned files change. It does not publish, tag, push, edit the version, or mutate the host project.

Also inspect the candidate directly:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm check
pnpm release:check
pnpm audit --prod
npm pack --dry-run
npm pack
git diff --check
git status --short
```

`prepack` performs a clean build. Inspect the JSON pack metadata for name/version, packed and unpacked sizes, file count, and the complete allowlist. The tarball must contain only `dist`, `README.md`, `LICENSE`, and `package.json`; it must not contain source, tests, scripts, local paths, histories, credentials, logs, coverage, screenshots, or another tarball.

## Installed-package and dogfood checklist

Use the real tarball in disposable projects. Verify npm local/global/exec, pnpm local, and direct-binary invocation; version/help; paths containing spaces and Unicode; and safe nested-directory refusal. Exercise:

1. Default and Custom onboarding, doctor, deterministic planning, shared and worktree execution.
2. Passing, agent, preparation, verification, policy, dirty-baseline, timeout, retry, dependency-block, resume, rerun, and interruption outcomes.
3. History, task/batch reports, JSON purity, `NO_COLOR`, CSV formula neutralization, Markdown/HTML escaping, corrupt records, missing artifacts, and latest-pointer fallback.
4. Result review, bounded diff, safe export/collision, clean apply, advanced-target apply, conflict rollback, idempotent discard, cleanup dry-run, cleanup execution, and preserved audit history.
5. Real POSIX PTY launch/monitor/detach/reopen/cancel/review/resize/teardown where supported. On Windows, require simulated terminal coverage and explicit POSIX-PTY/signal skips.

Use [the release test matrix](./release-test-matrix.md) to classify automated, platform-specific, and manual evidence. Do not call an unexecuted scenario passed.

## Compatibility and safety review

- Validate versionless/v1/v2/v3 configuration adapters and v1-v3 run, v1 batch, v1 change-artifact, and v1 promotion readers without rewriting history.
- Inspect run v4, batch v2, workspace v1, change-artifact v2, promotion-record v2, and management-action v1 output for schema consistency and repository-relative safe paths.
- Confirm primary-checkout protection, clean-target enforcement, result/ref ownership, rollback state, unknown-worktree refusal, immutable history, sensitive-path omission, terminal sanitization, and HTML/Markdown/CSV injection protection.
- Review [supported environments](./supported-environments.md) and [known limitations](./known-limitations.md). Dependency audit output is point-in-time evidence, not security certification.

## Publication and post-publication

Only after every blocker is resolved and the complete CI matrix is green:

1. Choose and apply the release version and changelog heading in one reviewed commit.
2. Re-run `pnpm release:check` from that commit and inspect `npm pack --dry-run`.
3. Create the tag and publish the package with the intended npm provenance/access policy.
4. Install the registry artifact into a new temporary project and repeat version, help, init, doctor, plan, run, report, and non-TTY TUI checks.
5. Publish release notes that match the changelog and explicitly retain known limitations.

If registry verification fails, stop further promotion, deprecate the affected version with a precise reason where appropriate, document recovery, and prepare a new patch version. Do not rewrite an existing published tarball or tag.
