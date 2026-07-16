# Safe Self-hosting Scenarios

These fixtures dogfood Ariadne without mutating this checkout. Every scenario creates a separate temporary Git repository, plans a v4 workflow, runs deterministic fake processes in shared or worktree mode, generates child and batch HTML, verifies the expected exit code, and removes the repository afterward.

From the Ariadne repository root:

```sh
pnpm build
node examples/self-hosting/run-scenarios.mjs
```

The scenarios cover configuration validation, a worktree-isolated fix, changed-file limits, ignored forbidden files, timeout cleanup, a dirty baseline modified again, and report generation. Package smoke also covers inspect/diff/apply/conflict/discard/cleanup, dependency blocking, retries, interruption, resume, and rerun. All use local Node processes only; no network, credentials, or external coding agent is involved.
