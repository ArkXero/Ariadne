# Ariadne

Ariadne is a local-first CLI for evaluating coding-agent reliability. It runs file-based tasks serially in the current working tree, captures bounded process evidence and Git attribution, evaluates deterministic policies, and writes recoverable JSON plus offline HTML reports.

Ariadne is an observability and policy tool. It is not an operating-system sandbox, secrets vault, hosted service, or proof that command-like text in agent output actually executed.

## Requirements and installation

- Node.js 20 or newer
- pnpm 10.34.1 for development
- Git when changed-file or diff-line policies are enabled

```sh
pnpm install
pnpm build
pnpm link
ariadne --help
```

The linked command runs `dist/cli.js`; rebuild after source changes. `pnpm smoke` verifies global binary installation from a disposable staged package and an isolated temporary `PNPM_HOME`, without altering the checkout or host global pnpm setup. The project remains pinned to pnpm 10.34.1. With pnpm 11, use its replacement command, `pnpm add --global .`.

The npm package declares Node.js 20 or newer. The maintained CI matrix validates Ubuntu on Node 20, 22, and 24 and macOS/Windows on Node 22; other later Node releases are not part of the required matrix. pnpm is required only to develop Ariadne—an installed npm tarball runs with its production dependencies and Node.

## Quick start

Run these commands in the repository you want to evaluate:

```sh
ariadne init
ariadne doctor
ariadne run
ariadne list
ariadne report
```

`init` creates a v2 `ariadne.yml`, `.ariadne/tasks/example.yml`, `.ariadne/runs/`, and host `.gitignore` entries for `/.ariadne/` and `/ariadne.yml`. Existing files are not overwritten.

The v2 command contract uses direct executable/argument arrays by default:

```yaml
version: 2

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

checks:
  forbidden_files: [.env, ".env.*"]
  forbidden_commands: ["rm -rf"]
  max_changed_files: 20
  max_diff_lines: 500
```

Use an explicit shell only when shell syntax is required:

```yaml
command:
  kind: shell
  command: "pnpm typecheck && pnpm test"
```

Versionless and v1 string-command configurations remain readable through a compatibility adapter and produce doctor warnings. New examples and `init` emit v2.

## Tasks

Tasks are strict YAML files loaded recursively from `tasks.directory`:

```yaml
id: fix-parser
name: Fix parser regression
metadata:
  issue: 42
prompt: |
  Reproduce the parser regression, make the smallest safe fix, and run tests.
```

IDs must match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. Filename-derived IDs are supported when valid. Duplicate IDs are rejected case-insensitively with every conflicting file named. Task prompts are sent on stdin and exposed to the agent process, but run records store only prompt length and SHA-256 hash.

## CLI contracts

Global flags are `--verbose`, `--quiet`, `--json`, and `--no-color`. Machine-readable modes reserve stdout for the payload; warnings and progress go to stderr.

```sh
ariadne run --task fix-parser
ariadne list --format compact
ariadne list --format wide
ariadne list --format json
ariadne list --format csv --output exports/runs.csv
ariadne list --format markdown --output exports/runs.md
ariadne report --run <run-id-or-path> --output reports/run.html
```

The existing `list --wide`, `--csv`, `--md`, and global `--json` flags remain aliases. See [docs/cli-contract.md](./docs/cli-contract.md) for exit codes and routing guarantees.

## Run artifacts

Each run owns an exclusive directory:

```text
.ariadne/runs/<run-id>/
├── run.json
├── report.html
└── artifacts/<task-id>/
    ├── agent.stdout.log
    ├── agent.stderr.log
    ├── verification-1.stdout.log
    ├── verification-1.stderr.log
    └── repository.diff
```

Manifests are checkpointed with temp-file, flush, atomic rename, and best-effort directory sync. `latest.json` is updated only after a valid terminal manifest exists. Full raw process bytes stay in artifact files; the manifest retains bounded 4 KiB head and 12 KiB tail previews, byte counts, and invalid UTF-8 replacement metadata.

Historical v1 flat JSON runs remain readable and are never rewritten. Corrupt or future records produce warnings and are skipped by `list` instead of crashing history.

## Policies and outcomes

Policies are pure and stable:

| Policy | Failure penalty |
| --- | ---: |
| `files.forbidden` | 40 |
| `commands.forbidden` | 30 |
| `changes.max-files` | 15 |
| `changes.max-diff-lines` | 15 |

The score is `100 - unique failed-policy penalties`, clamped to `0..100`. Execution status, verification status, policy results, numeric score, task outcome, and CLI exit code remain separate. Direct configured commands can be blocked before launch; command-like output is reported evidence and a warning, not proof of execution or a hard violation.

Git attribution compares task baseline, post-agent, and post-verification snapshots. Unchanged preexisting dirt is reported separately, while a task-caused second modification is attributed. Ignored forbidden files and symlink-target changes are checked without following external symlink targets.

## Development and validation

```sh
pnpm check
npm pack --dry-run
pnpm test:package
```

`pnpm check` is the authoritative local and CI gate: no-emit TypeScript validation, clean build, all Vitest suites, linked-CLI smoke testing, package-content assertions, and installed-tarball execution.

More detail:

- [Architecture](./docs/architecture.md)
- [Lifecycle](./docs/run-lifecycle.md)
- [CLI contract](./docs/cli-contract.md)
- [Run format](./docs/run-format.md)
- [Agent adapters](./docs/agent-adapters.md)
- [Task isolation](./docs/task-isolation.md)
- [Testing](./TESTING.md)
- [Release process](./docs/releasing.md)
- [Supported environments](./docs/supported-environments.md)
- [Known limitations](./docs/known-limitations.md)
- [Safe self-hosting fixtures](./examples/self-hosting/README.md)
