# Ariadne Baseline

Ariadne is a local CLI for running reliability evaluations against coding agents.

Current known commands:
- init
- doctor
- run
- list
- report

Current invariant:
- pnpm check must pass before any task is considered complete.

Project rules:
- Keep command handlers thin.
- Put real behavior in src/core.
- Keep shared types in src/types/index.ts unless a more specific type file is clearly justified.
- Prefer small, testable changes.
- Do not change public CLI behavior unless the task explicitly asks for it.
- Do not add hosted auth, database, or dashboard infrastructure yet.
- Do not modify .env files.
- Do not commit generated run artifacts.
