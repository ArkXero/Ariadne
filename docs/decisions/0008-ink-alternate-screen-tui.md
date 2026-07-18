# ADR 0008: Ink TUI with a separate alternate-screen adapter

## Status

Accepted.

The inspection-only scope was extended by [ADR 0009](./0009-operational-tui-runtime-events.md). The Ink, visual, responsive, and terminal-ownership decisions here remain in force.

## Context

Ariadne needs a local, read-only inspection view while retaining Node.js 20 support. Ink 6.8 and React 19 provide terminal-native layout, input handling, and testing without introducing a browser DOM. Ink 7 requires a newer Node baseline. Ink owns raw input and rendering but does not define Ariadne's full-screen lifecycle contract.

The persisted readers, report models, workspace metadata, promotion records, and Git result-reference helper are already authoritative. Reimplementing their logic inside components would create status drift and make corrupt/future compatibility inconsistent with `list` and `report`.

## Decision

- Use pinned Ink 6.8 with React 19 while Ariadne supports Node 20.
- Keep terminal-native React components under `src/tui/`; do not add browser-oriented Tuimorphic or CSS effects.
- Put all persistence, compatibility, report, workspace, promotion, and log reads behind typed TUI application services.
- Put alternate-screen entry, cursor restoration, SIGINT/SIGTERM cleanup, color capability, and Unicode fallback behind a separate terminal adapter.
- Use explicit reducer screens, a back stack, per-screen selection, request generations, and cached details/logs.
- Render a fixed-height shell with a one-row header and footer. Use master/detail previews at 100+ columns and 20+ rows, then preserve drill-down navigation at compact and stacked sizes.
- Clear and home the alternate screen before the first Ink render so application content always starts at row one.
- Iteration 5 kept refresh manual and the TUI inspection-only; ADR 0009 supersedes this scope while retaining the architecture and visual contract above.

## Consequences

The visual design consumes shared semantic tokens with sentence-case typography, textual status labels, restrained symbols, windowed lists, and responsive rounded Coral line frames rather than theatrical system copy or CRT simulation. Adjacent panes use zero-cell gutters to keep the dashboard dense; ASCII fallback remains square. Cyan identifies selection and running work, Green identifies success, Coral identifies frames and failure, Orange identifies caution, and Slate separates metadata. The interface does not animate or continuously redraw. Components are deterministic enough for fixed-viewport string rendering and terminal-stream tests. A normal quit, initialization/render failure, SIGINT, or SIGTERM runs the same idempotent restoration path.

Upgrading to Ink 7 is a deliberate Node-support decision, not an incidental dependency update. Full logs and external actions stay outside the TUI.
