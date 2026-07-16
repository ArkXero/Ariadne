# Release Process

1. Confirm the working tree contains only intended changes.
2. Update `CHANGELOG.md` and package version together.
3. Install with the locked pnpm version and frozen lockfile.
4. Run the complete acceptance gate:

   ```sh
   pnpm check
   npm pack --dry-run
   pnpm test:package
   git diff --check
   git status --short
   ```

5. Inspect tarball contents for stale `dist`, source/tests/scripts, credentials, absolute personal paths, and missing shebang/bin metadata.
6. Inspect generated run v4, batch v2, workspace v1, change v1, and promotion v1 records plus offline HTML for schema drift, link consistency, unsafe paths, hostile-content escaping, and accidental secret/path inclusion.
7. Verify versionless/v1/v2/v3 config, v1/v2/v3 run, and v1 batch compatibility readers without rewriting history.
8. Exercise shared/worktree planning, dependency layering, retry, interruption, resume/rerun, changes/diff, clean apply, conflict, discard, and cleanup from the installed tarball outside the checkout.
9. Tag and publish only after the Ubuntu Node 20/22/24 and macOS/Windows Node 22 CI matrix succeeds.

The package build always removes `dist` first. Do not publish from a build path that bypasses `pnpm build` and `pnpm test:package`.

## Supported release matrix

- Package engine: Node.js 20 or newer.
- Required CI: Ubuntu on Node 20, 22, and 24; macOS and Windows on Node 22.
- Development package manager: pnpm 10.34.1 from `packageManager`.
- Installed package: npm-compatible tarball with production dependencies; pnpm is not required at runtime.
- Git: optional for shared execution without Git-dependent limits; required for worktree isolation, durable result capture, and promotion.

Do not describe an untested operating-system/Node combination as CI-validated. Review [supported environments](./supported-environments.md) and [known limitations](./known-limitations.md) with every release.
