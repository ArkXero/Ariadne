# Ariadne

Ariadne is a local-first CLI for evaluating coding-agent reliability and orchestrating file-based task workflows. It can run tasks in the shared checkout or detached Git worktrees, capture successful changes as durable local result commits, and promote reviewed result closures explicitly.

Ariadne is an observability and policy tool. It is not an operating-system sandbox, secrets vault, hosted service, or proof that command-like output actually executed.

## Requirements and installation

- Node.js 20 or newer
- pnpm 10.34.1 for development
- Git when changed-file/diff policies or worktree isolation are enabled

```sh
pnpm install
pnpm build
pnpm link
ariadne --help
```

The repository is pinned to pnpm 10.34.1. With pnpm 11, use `pnpm add --global .` instead of the removed global-link behavior. An installed npm package needs Node and its production dependencies, not pnpm.

## Quick start

Run these commands in a repository you want to evaluate:

```sh
ariadne init
ariadne doctor
ariadne plan --all
ariadne run --all
ariadne list --batches
ariadne report
```

In an interactive terminal, `init` offers a repository-aware Default setup and a Custom setup. Default detects the project type, package manager, validation script, installed Codex/Claude Code executable, and Git worktree capability; it imports the strongest detected validation command as a task. Custom additionally configures task dependencies, isolation, concurrency, retries, sensitive-file protections, change limits, and timeouts, then provides YAML and file-diff review before writing.

`ariadne init --yes` accepts detected defaults without prompts. Plain non-interactive `ariadne init` keeps the portable example-agent behavior used by automation. `--custom` requires a TTY.

An existing `ariadne.yml` is never overwritten automatically. Interactive `init` defaults to validation and offers explicit Default/Custom replacement. Replacement always shows a diff, validates the proposal before touching the original, creates an ignored timestamped backup, and then performs atomic writes. Existing task files are never overwritten.

```yaml
version: 4

agent:
  command:
    kind: exec
    file: codex
    args: [exec, --sandbox, workspace-write, -]
  timeout_ms: 600000

tasks:
  directory: .ariadne/tasks

verification:
  commands:
    - kind: exec
      file: pnpm
      args: [test]
  timeout_ms: 300000

execution:
  termination_grace_ms: 2000
  concurrency: 1
  failure_mode: continue
  isolation: shared
  worktree:
    retention: on-failure
    preparation:
      commands: []
      timeout_ms: 600000

checks:
  forbidden_files: [.env, ".env.*"]
  forbidden_commands: ["rm -rf"]
  max_changed_files: 20
  max_diff_lines: 500
```

Direct `exec` specifications preserve argument boundaries. Use `{ kind: shell, command: "pnpm typecheck && pnpm test" }` only when shell syntax is intentional. Versionless and v1–v3 configurations remain readable through compatibility adapters and emit warnings.

## Workflow tasks

Tasks are strict YAML files loaded recursively from `tasks.directory`:

```yaml
id: package
name: Validate and package
dependsOn: [integration-tests]
workspaceMode: mutable
retry:
  attempts: 3
  delayMs: 1000
  backoff: fixed
verify:
  - kind: exec
    file: pnpm
    args: [build]
metadata:
  issue: 42
prompt: Validate and package the project.
```

`dependsOn` is case-insensitive and includes transitive dependencies when a task is selected. `workspaceMode` defaults to `mutable`. In shared isolation, mutable tasks are exclusive and only read-only tasks may overlap. In worktree isolation, mutable tasks may overlap because each attempt has a detached checkout. Omitted `verify` inherits global verification; `verify: []` disables it.

Retries in shared mode preserve the current tree. Worktree retries start from a fresh checkout of the recorded source plus successful dependency results; failed-attempt mutations are not inherited. V3 `parallelSafe: true` adapts to `workspaceMode: read-only` with a migration warning.

IDs must match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. Filename-derived IDs are supported when valid. Duplicate IDs and dependencies are compared case-insensitively. Missing, self, duplicate, and cyclic dependencies fail before execution.

## CLI

Global flags are `--verbose`, `--quiet`, `--json`, and `--no-color`. Machine-readable modes reserve stdout for the payload; warnings and progress go to stderr.

```sh
ariadne plan package --concurrency 2
ariadne run package
ariadne run --task lint --task test
ariadne run --all --failure-mode fail-fast
ariadne run --all --isolation worktree
ariadne plan --all --isolation worktree --allow-dirty-base
ariadne resume <batch-id> --concurrency 2
ariadne rerun <batch-id> --failed
ariadne rerun <batch-id> --task package
ariadne list --tasks --format wide
ariadne list --batches --format json
ariadne list --batches --format csv --output exports/batches.csv
ariadne report --run <run-id-or-path>
ariadne report --batch <batch-id-or-path> --output reports/workflow.html
ariadne changes <run-id>
ariadne diff <run-id> --output exports/result.patch
ariadne status <run-id>
ariadne apply <run-id>
ariadne discard <run-id>
ariadne worktree clean --dry-run
```

`run` with no selectors remains equivalent to `--all`. `plan` is read-only: it creates no run or batch record and launches no processes. `list` defaults to child task attempts. `report` follows `.ariadne/latest.json` by default. Existing list format flags remain aliases. See [the CLI contract](./docs/cli-contract.md) for selection rules and exit codes.

## Records and reports

```text
.ariadne/
├── latest.json
├── batches/
│   ├── latest.json
│   └── <batch-id>/
│       ├── batch.json
│       └── report.html
├── worktrees/<workspace-id>/workspace.json
├── promotions/<promotion-id>.json
└── runs/
    ├── latest.json
    └── <run-id>/
        ├── run.json
        ├── report.html
        └── artifacts/<task-id>/...
```

A batch references child attempt manifests instead of duplicating process traces. Run record v4 adds workspace, prepared/source/result revisions, change artifacts, applicability, cleanup, and workflow linkage. Batch record v2 stores isolation and result references. Workspace v1 and promotion v1 records remain separate so execution history is immutable. Historical v1–v3 runs and v1 batches remain read-only compatible.

Manifest writes use a same-directory temporary file, sync, atomic rename, and best-effort directory sync. Latest pointers update only after valid terminal manifests exist. Raw stdout/stderr bytes stream to artifacts; manifests retain bounded 4 KiB head and 12 KiB tail previews.

## Isolation and promotion

Shared mode is the compatibility default. Mutable tasks run alone; read-only tasks may overlap and fail `workspace.read-only` if Git-visible mutation occurs. Worktree mode creates detached checkouts from committed `HEAD`, layers successful dependency result commits, and permits isolated mutable overlap up to `execution.concurrency`.

Successful safe changes are committed under `refs/ariadne/results/<run-id>`. `changes` and `diff` are inspection commands. `apply` requires the same repository, a clean named branch, an eligible unapplied result, and surviving refs. It preflights the unresolved dependency closure in a temporary worktree, creates one squashed commit, then cherry-picks it into the unchanged primary checkout. `discard` removes only managed refs/worktrees; manifests and artifacts remain.

Git worktrees isolate repository state, not operating-system permissions, external paths, services, caches, network access, credentials, or arbitrary subprocess side effects. Dirty-source acknowledgement uses committed `HEAD` only and records excluded primary dirt. Secret omission and log redaction are best effort beyond configured forbidden files and tested `.env` paths.

## Policies

| Policy | Failure penalty |
| --- | ---: |
| `files.forbidden` | 40 |
| `commands.forbidden` | 30 |
| `changes.max-files` | 15 |
| `changes.max-diff-lines` | 15 |
| `workspace.read-only` | 100 |

The policy score is `100 - unique penalties`, clamped to `0..100`. Execution, verification, policy status, numeric score, task outcome, batch status, and CLI exit code remain separate. Command-like process output is warning-only reported evidence.

## Development and validation

```sh
pnpm check
npm pack --dry-run
pnpm test:package
```

`pnpm check` performs no-emit TypeScript validation, a clean build, all tests, a disposable global-command smoke test, package-content assertions, and installed-tarball workflow execution.

Documentation:

- [Architecture](./docs/architecture.md)
- [Workflow orchestration](./docs/workflows.md)
- [Lifecycle](./docs/run-lifecycle.md)
- [CLI contract](./docs/cli-contract.md)
- [Record formats](./docs/run-format.md)
- [Agent adapters](./docs/agent-adapters.md)
- [Task isolation](./docs/task-isolation.md)
- [Testing](./TESTING.md)
- [Release process](./docs/releasing.md)
- [Supported environments](./docs/supported-environments.md)
- [Known limitations](./docs/known-limitations.md)
- [Safe self-hosting fixtures](./examples/self-hosting/README.md)
