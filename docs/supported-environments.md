# Supported Environments

## Runtime

The npm package declares Node.js 20 or newer. The release gate is required to pass on:

- Ubuntu with Node.js 20, 22, and 24;
- macOS with Node.js 22;
- Windows with Node.js 22.

Later Node.js majors may work, but they are not part of the required CI matrix until added explicitly. Ariadne is a Node.js ESM CLI and does not require pnpm after installation.

## Development and packaging

The repository is pinned to pnpm 10.34.1. `pnpm check` performs the clean build, tests, linked-command smoke, and installed-tarball smoke. The package smoke installs the packed artifact into a disposable project and invokes the installed binary outside this checkout.

pnpm 11 is compatibility-tested only through the optional `ARIADNE_SMOKE_PNPM_VERSION=11.13.0 pnpm smoke` branch. It uses `pnpm add --global .` because pnpm 11 removed the old global-link command.

## Git and platforms

Git is required when `max_changed_files` or `max_diff_lines` is configured. Without those policies, Ariadne can run outside Git, but repository attribution is unavailable; configured forbidden-file snapshots still operate on visible matching paths.

POSIX and Windows use different process-cleanup mechanisms. See [Known limitations](./known-limitations.md) before interpreting cleanup metadata as a security guarantee.
