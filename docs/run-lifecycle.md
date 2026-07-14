# Run Lifecycle

The v2 lifecycle stages are:

1. `created`
2. `loading`
3. `validated`
4. `preparing`
5. `agent_running`
6. `agent_finished`
7. `verifying`
8. `collecting_trace`
9. `evaluating_policy`
10. `scoring`
11. `persisting`
12. `completed`

The run directory and initial `created` manifest exist before config loading. Global checkpoints are written during load/validation/preparation and task-local events cover process, trace, policy, score, and completion stages.

## Failure behavior

- An agent nonzero exit records an agent failure and still permits verification.
- A spawn failure skips verification because no agent ran.
- A timeout permits verification only after the launched POSIX process group is no longer observable or Windows `taskkill` reports success. Windows cleanup remains best-effort, and a detached POSIX descendant can escape the original process group.
- Ordinary task failures do not prevent later selected tasks from running.
- Interruption or unrecoverable internal failure prevents new tasks from launching.
- One signal coordinator aborts active work; a second SIGINT/SIGTERM exits immediately.
- The terminal finalizer is idempotent and derives run status/summary from task outcomes once.

Mixed-task precedence is interruption, internal failure, timeout, agent failure, verification failure, policy failure, then success. This aggregation is separate from policy score.

## Persistence and abandonment

Every manifest write uses a same-directory temporary file, exclusive create, file sync, close, atomic rename, and best-effort parent directory sync. Terminal `latest.json` is written only after manifest schema validation and terminal persistence succeed.

The manifest records PID, hostname, and owner start time. When a same-host record remains `running` but its PID no longer exists, readers display it as `abandoned` with a warning. Ariadne does not silently rewrite that historical manifest.
