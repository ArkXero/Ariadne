# Ariadne TUI

`ariadne tui` is a keyboard-first local control surface for workflow planning, launch, monitoring, cancellation, resume, rerun, and persisted-history inspection. It uses the same application service, planner, scheduler, compatibility readers, and canonical report models as the non-interactive CLI. Persisted batch/run schemas are unchanged.

## Visual contract

Every screen fills the alternate-screen viewport with a one-row header, flexible body, and one-row footer. Rounded panes meet at zero-cell gutters. The responsive breakpoints remain `100/60/40`: master/detail at 100+ columns and 20+ rows, compact log-preserving drill-down at 60–99, stacked content at 40–59, and a recoverable minimum screen below 40 columns or 12 rows.

Coral is the brand, frame, failure, and confirmation accent. Focused text uses the existing bold Cyan `>` treatment. Important labels retain bold and textual semantic cues in monochrome. Green means passed, Orange means warning/waiting, Snow carries primary values, and Slate carries metadata. UTF-8 terminals use rounded frames and middle dots; ASCII fallback uses square frames and `|`. There are no gradients, animations, scanlines, glow effects, or mouse-only actions.

Long lists are windowed around selection. Footer/help content comes from the centralized implemented keymap, and footer groups are omitted whole when space is limited. See the [design system](./design-system.md).

## Planning and launch

The dashboard separates the current process's attached workflow from persisted running/incomplete records that have `no active runtime attached`. Press `p` to open task selection. Direct selection starts empty; dependency inclusion happens only during planning.

The planning path is:

1. Select direct roots with Space, `a`, or `x`.
2. Enter builds a non-mutating current-configuration preview.
3. Review root/dependency markers, levels, concurrency groups, retries, verification count, isolation, failure mode, retention, source revision, dirty state, warnings, and blockers.
4. `e` edits concurrency `1..32`, failure mode, isolation, or dirty-base acknowledgement. Retry limits are task semantics and are not overridden here.
5. Enter replans after option changes, then advances to an explicit launch confirmation.
6. Enter on confirmation creates the active workflow. Esc at any prelaunch screen creates no active entry.

Resume and rerun use the same current-configuration planning and confirmation path. Source records remain immutable:

| Key on workflow history | Preview |
| --- | --- |
| `R` | Resume compatibility, reusable tasks, and requeued tasks |
| `f` | Failed tasks as current roots |
| `B` | Maximal blocked descendants as roots, falling back to failed tasks |
| `A` | All original selected roots |

## Live workflow

The live screen combines workflow progress, a selectable task table, selected-task/process state, and a log-dominant pane. Preparation, agent, and verification processes are distinct. Retry countdowns derive from persisted `retryAt`. Blocked tasks show the dependency chain and zero attempts.

Runtime output is a provisional responsiveness hint. Output is redacted before event emission, decoded with streaming UTF-8 semantics, sanitized before buffering, and separated by run/process/stream. Each buffer retains at most 500 lines and 256 KiB and inserts `[earlier output truncated]`. Full output lives only in artifact files. The TUI reconciles attached state from persistence every second, on `r`, and at completion; persisted status, policy results, scores, and history win.

Subscribers receive events asynchronously so the scheduler never waits for rendering. Each subscriber queue is limited to 512 events and 1 MiB of output. Ariadne drops oldest output first, coalesces replaceable state, preserves cancellation/completion, and surfaces truncation or runtime sequence gaps. A subscriber that cannot accept non-droppable events is disconnected.

## Cancellation, detach, and signals

`c` or Ctrl-C opens confirmation; neither cancels immediately. Enter makes one idempotent cancellation request and shows launch stopping, retry-delay cancellation, process termination, task finalization, and batch finalization. Repeated requests share the same completion promise.

Esc from live monitoring returns to the dashboard without cancellation. Enter on the attached dashboard row reopens live monitoring. Restarted Ariadne processes can inspect old running/incomplete records but cannot control or claim reattachment to their operating-system processes.

With no active workflow, `q` exits immediately. With one active workflow, `q` opens detach confirmation. Confirming restores raw mode, cursor, and the alternate screen while execution continues headlessly in the same foreground Ariadne process; the shell stays occupied until completion. Ctrl-C while headless requests cancellation.

SIGINT/SIGTERM request cancellation, wait up to `min(30s, 2 * termination_grace_ms + 5s)`, restore terminal state, and report exit code 130/143. A render failure restores the terminal and lets the registry-owned workflow finish safely before the error is returned.

## Exact key tables

Global navigation:

| Key | Action |
| --- | --- |
| `q` | Quit, or confirm headless detach while active |
| `?` | Contextual help |
| Esc / `b` | Back; from live, detach to dashboard without cancellation |
| `r` | Refresh history and reconcile attached runtime |
| `w` | Warnings |
| `h` | History |
| `j` / Down, `k` / Up | Move focus |
| `g`, `G` | First/last item |
| Enter | Open/advance/confirm according to the current screen |

Operational screens:

| Screen | Keys |
| --- | --- |
| Dashboard | `p` plan; Enter opens history or reopens the attached live workflow |
| Task selection | Space toggle; `a` select all; `x` clear; Enter plan; Esc return |
| Plan review | `e` options; Enter confirmation; Esc selection/history |
| Options | `j`/`k` or arrows choose field; `h`/`l` or Left/Right change value; Enter replan; Esc discard draft |
| Launch confirmation | Enter launch; `e` options; Esc cancel launch |
| Live workflow | `j`/`k` task; Tab process; `o` stdout; `e` stderr; Enter task detail; `r` reconcile; `c`/Ctrl-C cancel confirmation; Esc dashboard |
| Cancel confirmation | Enter request cancellation; Esc continue monitoring |
| Resume/rerun preview | `e` options; Enter launch confirmation; Esc history |
| Exit confirmation | Enter restore terminal and continue headlessly; Esc continue monitoring |

History/detail screens:

| Screen | Keys |
| --- | --- |
| History | Tab batch/task mode; `f` cycle filters; Enter inspect |
| Workflow | `a` attempt summary; `R` resume; `f` failed rerun; `B` failed branch; `A` all roots; Enter task |
| Task | Enter attempt |
| Attempt | `[`/`]` attempt; Tab process; `o`/`e` stdout/stderr; PgUp/PgDn and `g`/`G` preview movement |

## Safety and compatibility

Non-TTY invocation exits 2 with empty stdout, plain stderr, and no terminal-control output. `--json` and `--quiet` are rejected. `--verbose`, `--no-color`, and `NO_COLOR` are supported. Missing configuration, empty history, corrupt records, and future records remain safe inspection states.

Components never invoke Git or interpret persistence. The application service owns planning/execution, the external registry owns live handles, runtime reducers own provisional state, and canonical readers own final state. Persisted strings and output are terminal-sanitized. Historical file previews remain contained, binary-aware, and limited to the final 64 KiB; live buffers do not replace artifacts.

## Verification and dogfood

`pnpm test:tui-pty` uses the POSIX system PTY facility through Python's standard-library `pty` module when `python3` is available and otherwise reports the simulated-terminal fallback. It exercises selection, planning, launch, live output, dashboard detach/reopen, cancellation confirmation, a resize signal, and teardown.

`pnpm dogfood:tui` builds a disposable repository and opens the real TUI. Exercise success, dependency blocking, concurrency, retry success/exhaustion, verification/policy failure, dirty-base warnings, worktree isolation, normal quit, dashboard detach/reopen, confirmed headless detach, cancellation, SIGINT, SIGTERM, and terminal sizes `120x30`, `80x24`, `50x20`, and below `40x12`.
