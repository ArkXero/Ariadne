# Architecture

Ariadne is a local Node.js ESM CLI. Commands remain thin; versioned core modules own validation, planning, scheduling, attempt execution, evidence, persistence, aggregation, and rendering.

## Data flow

1. `src/cli.ts` parses global and command options and preserves stdout/stderr routing.
2. `src/core/config.ts` strictly validates v4 or adapts versionless/v1/v2/v3 input into an immutable v4 configuration rooted at the canonical invocation directory.
3. `src/core/task-loader.ts` discovers strict task files and applies source-version defaults.
4. `src/core/workflow-graph.ts` canonicalizes dependencies and provides deterministic lookup, closure, cycle detection, dependents, and topological levels.
5. `src/core/workflow-planner.ts` creates the semantic fingerprint and content-derived plan ID. The timestamp is informational and is excluded from plan identity.
6. `src/core/workflow-runner.ts` owns readiness, shared/worktree concurrency, retries, dependency-result layering, primary-checkout guards, failure propagation, and batch aggregation.
7. `src/core/workspace-manager.ts` owns detached worktree metadata, validation, lifecycle, and guarded cleanup. `src/core/runner.ts` executes one attempt against a distinct execution root while artifacts remain in the primary run tree.
8. `src/core/process-runner.ts` streams raw output to artifacts and coordinates timeout/interruption cleanup.
9. `src/core/git.ts`, `src/core/forbidden-files.ts`, and `src/core/change-capture.ts` capture evidence, safe result commits, patches, previews, and sensitive omissions.
10. `src/core/batch-persistence.ts` and `src/core/persistence.ts` atomically checkpoint versioned batch and child manifests.
11. `src/core/promotion.ts` owns immutable apply/discard events and transactional preflight. Versioned readers tolerate corrupt/future history; canonical report views drive terminal, JSON, list, CSV, Markdown, and offline HTML output.

## Ownership boundaries

- The graph resolves identity and dependency relationships; the planner contains no process execution.
- The orchestrator owns workflow state, but never duplicates child logs, traces, policies, or scores.
- Each child attempt remains independently reportable and links to its batch, plan, task, and globally increasing attempt number.
- Renderers consume persisted/canonical outcomes; they do not recalculate policy or scheduler status.
- Resume reuses valid successful references and current configuration semantics; rerun always builds a new plan from current input.
- Invocation/artifact roots are distinct from execution roots. Repository-relative paths and opaque repository identity are persisted. Prompts and environment values are excluded from manifests.

## Determinism and recovery

Case-insensitive task-ID ordering breaks graph, root, edge, level, ready-queue, and completion ties. Plan IDs derive from graph/config semantics and effective runtime settings, excluding creation time and the resume-allowed concurrency override from the semantic fingerprint. Exclusive directory creation prevents ID collisions from overwriting history.

Every attempt and batch is checkpointed. Terminal child, batch, and invocation pointers update only after schema-valid manifests exist. A same-host `running` record owned by a dead PID is displayed as abandoned without rewriting history.

## Isolation boundary and non-goals

Git worktrees isolate repository checkout state only. There is no container, remote execution, server, database, authentication, telemetry, hosted dashboard, TUI, source-control abstraction, automatic merge/push, or security-sandbox claim. Operating-system permissions, network, external paths, services, caches, credentials, and arbitrary subprocess side effects remain outside the isolation boundary.
