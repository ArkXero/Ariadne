# Workflow Orchestration

## Planning

The graph canonicalizes IDs case-insensitively while preserving declared spelling. Dependencies and dependents are sorted; stable cycle diagnostics include the canonical cycle path. Selected roots expand to their transitive dependency closure and then to deterministic topological levels and order.

The plan ID is content-derived from the semantic configuration, selected roots, graph, effective verification/retry settings, concurrency, and failure mode. `createdAt` is informational. The semantic fingerprint excludes concurrency so resume can change only that execution bound.

`inspectWorkflowOptions` and `createWorkflowPlanPreview` expose the same normalized catalog and deterministic plan to the CLI and TUI without launching processes. Previews include repository state, warnings, and launch blockers. Option editing is intentionally limited to concurrency, failure mode, isolation, and dirty-base acknowledgement; retry limits remain task semantics.

## Scheduling

Tasks default to exclusive. An exclusive task starts only when nothing else is active. Parallel-safe tasks can overlap only with other parallel-safe tasks and only up to the configured limit. Ready queues and completion application follow plan order.

`workspaceMode` is a task contract. Shared mode overlaps only read-only tasks and treats Git-visible mutation as a non-retriable policy failure. Worktree mode permits isolated mutable overlap by giving each attempt a detached checkout. Ignored changes, paths outside the checkout, caches, services, and external side effects may remain invisible.

For worktree workflows, every successful non-empty safe attempt creates `refs/ariadne/results/<run-id>`. Dependents receive successful dependency commits in plan order. Apply promotes the unresolved closure in the same order; batch scores and task status never make a result automatically apply.

Only the final attempt selected by a workflow task record is promotable. Earlier retries remain immutable review inputs and can be summarized, diffed, compared, and exported. Standalone runs remain promotable when their isolated result is otherwise eligible. The review application service derives execution, verification, policy, artifact, eligibility, promotion, and workspace dimensions independently so one status never hides another.

Apply is a three-stage operator action: eligibility, transient preflight, and dedicated confirmation. Execution accepts only the fingerprint of the currently previewed repository, branch, target revision, and dependency closure, then revalidates it under the exclusive management lock. A moved target requires a new preview. Apply/discard never merge attempts or select an earlier result implicitly.

## Retries

Automatic retries cover agent nonzero exit, verification failure, and timeout with sufficiently confirmed cleanup. Spawn, policy, parallel-safety, planning, internal, blocked, and interrupted outcomes do not retry. Fixed delays remain constant; exponential delays double deterministically and cap at one hour. No jitter is used.

Every attempt has its own run ID, manifest, artifacts, trace, score, and report. Retry budgets apply per invocation, while attempt numbers continue across resume. Repository changes are preserved deliberately.

## Resume versus rerun

Resume is crash/retry continuation: same semantics and HEAD, reusable successful children, and no history mutation. Rerun is a new evaluation: current configuration, selected current closure, and every included dependency executes again. Use rerun after workflow or repository changes.

The TUI preview modes are failed tasks, failed branch, and all original roots. Failed branch chooses maximal blocked descendants so the review shows the broadest affected branches, then falls back to failed tasks when no blocked descendant exists. Every mode replans against current configuration and requires explicit confirmation before creating related history.

## Runtime observation and control

`startWorkflowExecution` returns a process-local handle with batch ID, completion, subscription, latest provisional state, and idempotent cancellation. The registry permits one active workflow per TUI process. Runtime events are asynchronous and non-durable; final statuses, policies, scores, task history, and artifact paths always come from persisted records.

Restarted processes do not reattach to operating-system children. A persisted running/incomplete batch without a current registry handle is inspection-only and explicitly labeled unattached.
