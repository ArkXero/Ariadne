# Agent Adapters

Ariadne runs coding agents through one configured shell command. It does not use an SDK, hosted queue, browser session, or persistent daemon.

## Contract

For each task, `ariadne run`:

- loads a task YAML file;
- sends `task.prompt` to `agent.command` through stdin;
- sets task metadata in environment variables;
- waits for the command to exit;
- captures stdout, stderr, exit code, runtime, timeout status, git diff, changed files, and verification results.

The agent command should exit `0` only when it believes the task is complete. Ariadne still runs verification and scoring after that.

## Environment

Each agent process receives:

- `ARIADNE_TASK_ID`: task id after YAML/default validation.
- `ARIADNE_TASK_NAME`: task display name.
- `ARIADNE_TASK_FILE`: absolute path to the task YAML file.
- `ARIADNE_TASK_PROMPT`: same prompt text sent through stdin.

Verification commands receive `ARIADNE_TASK_ID`, `ARIADNE_TASK_NAME`, and `ARIADNE_TASK_FILE`.

## Codex CLI Example

Keep the trailing `-` so Codex reads the Ariadne prompt from stdin.

```yaml
agent:
  command: "codex exec --sandbox workspace-write -"
  timeout_ms: 600000
```

For stricter local runs, configure Codex approval and sandbox flags according to your own repository policy.

## Generic Shell Agent Example

```yaml
agent:
  command: "node scripts/sample-agent.mjs"
  timeout_ms: 600000
```

Minimal adapter:

```js
import { readFile, writeFile } from "node:fs/promises";

const prompt = await new Promise((resolve) => {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { data += chunk; });
  process.stdin.on("end", () => resolve(data));
});

await writeFile("AGENT_NOTES.md", `Task ${process.env.ARIADNE_TASK_ID}\n\n${prompt}\n`);
```

## Interactive Agents

Interactive tools can hang when they wait for approval prompts, editor input, or login flows. Prefer non-interactive flags and preconfigured credentials already available to the local shell. Keep `agent.timeout_ms` high enough for real work but low enough to fail stuck runs.

## Capture Limits

Ariadne captures process output and git state after each task. It does not perform OS-level process auditing, terminal replay, network tracing, or hidden filesystem monitoring. Forbidden command checks use configured command rules matched against configured/observed command lines, so they are a scoring signal rather than a security sandbox.
