# Agent Adapters

Ariadne launches one configured process per task. It has no SDK requirement, hosted queue, browser session, persistent daemon, or hidden execution service.

## Process contract

Configuration v4 retains the direct executable/argument contract introduced in v2:

```yaml
agent:
  command:
    kind: exec
    file: codex
    args: [exec, --sandbox, workspace-write, -]
  timeout_ms: 600000
```

`kind: exec` never invokes a shell. Arguments retain exact boundaries, which avoids platform quoting ambiguity and accidental shell expansion. Use `kind: shell` explicitly when pipes, redirects, expansion, or compound syntax are intentional:

```yaml
command:
  kind: shell
  command: "pnpm typecheck && pnpm test"
```

Legacy v1 strings are adapted to explicit shell processes. Versionless and v1–v3 inputs produce compatibility warnings.

For every task, Ariadne sends `task.prompt` through stdin, waits for termination, and records spawn/nonzero/signal/timeout/interruption/cleanup states separately. Agent nonzero exits still permit verification. Spawn failures skip verification. After a timeout, verification proceeds only when the launched POSIX process group is no longer observable or the Windows `taskkill` cleanup command reported success; the Windows result is still explicitly best-effort.

## Environment

Agent processes receive:

- `ARIADNE_TASK_ID`
- `ARIADNE_TASK_NAME`
- `ARIADNE_TASK_FILE` as a repository-relative path
- `ARIADNE_TASK_PROMPT`

Verification processes receive the first three variables, but not the raw prompt. Run manifests persist prompt hash and byte length rather than prompt text. Environment values are never persisted; only the names of explicitly provided variables are recorded. Arguments with common secret-bearing flag names receive best-effort redaction in manifests.

## Generic Node adapter

```yaml
agent:
  command:
    kind: exec
    file: node
    args: [scripts/agent.mjs]
```

```js
import { writeFile } from "node:fs/promises";

let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;
await writeFile("AGENT_NOTES.md", `Task ${process.env.ARIADNE_TASK_ID}\n\n${prompt}\n`);
```

Exit `0` only when the adapter believes its work completed. Ariadne independently evaluates verification and policies.

Each retry launches the same configured agent with a fresh baseline and independent record. Shared retries retain current-tree mutations. Worktree retries start from a fresh detached checkout plus successful dependency results; external state is not reset. Task-level `verify` overrides global verification; `verify: []` deliberately disables it.

## Output and command evidence

Bytes read from the launched process's stdout/stderr pipes stream directly to per-process artifact files. Output written elsewhere, emitted after descriptors are detached, or hidden by another tool is outside Ariadne's visibility. The manifest retains bounded 4 KiB head and 12 KiB tail previews, total captured byte counts, and whether invalid UTF-8 required replacement. Captured large output is not fully buffered in memory.

Configured agent and verification processes are known execution evidence and are checked before launch against forbidden-command rules. Command-looking text printed by an agent is unverified reported evidence: it can create a warning, but it is not proof of execution and cannot produce a hard command-policy violation by itself.

## Interactive tools and limits

Interactive agents can hang on approval, editor, or authentication prompts. Prefer noninteractive flags and already-configured local credentials. Ariadne attempts TERM then KILL against the launched POSIX process group and verifies whether that group remains visible. A descendant that creates a new session/process group can escape that boundary. Windows uses best-effort `taskkill /T` then `/F` and records cleanup limitations.

Ariadne does not audit syscalls, network activity, subprocess creation, terminal replay, or hidden filesystem access. It is not a security sandbox.
