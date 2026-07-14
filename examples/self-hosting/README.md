# Safe Self-hosting Scenarios

These fixtures dogfood Ariadne without mutating this checkout. Every scenario creates a separate temporary Git repository, runs one deterministic fake agent, generates an HTML report, verifies the expected exit code, and removes the repository afterward.

From the Ariadne repository root:

```sh
pnpm build
node examples/self-hosting/run-scenarios.mjs
```

The scenarios cover configuration validation, an isolated one-file fix, changed-file limits, ignored forbidden files, timeout cleanup, a dirty baseline that is modified again, and report generation. They use local Node processes only; no network, credentials, or external coding agent is involved.
