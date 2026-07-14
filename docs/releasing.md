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
6. Inspect a generated v2 manifest and offline HTML report for schema drift, duplicate status logic, unbounded content, unsafe paths, and hostile-content escaping.
7. Verify v1 config and v1 run compatibility tests still pass.
8. Tag and publish only after the Ubuntu Node 20/22/24 and macOS/Windows Node 22 CI matrix succeeds.

The package build always removes `dist` first. Do not publish from a build path that bypasses `pnpm build` and `pnpm test:package`.

## Supported release matrix

- Package engine: Node.js 20 or newer.
- Required CI: Ubuntu on Node 20, 22, and 24; macOS and Windows on Node 22.
- Development package manager: pnpm 10.34.1 from `packageManager`.
- Installed package: npm-compatible tarball with production dependencies; pnpm is not required at runtime.
- Git: optional for execution without Git-dependent limits, required for changed-file and diff-line policies.

Do not describe an untested operating-system/Node combination as CI-validated. Review [supported environments](./supported-environments.md) and [known limitations](./known-limitations.md) with every release.
