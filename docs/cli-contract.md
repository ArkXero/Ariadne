# CLI Contract

## Global options

- `--verbose`: include stack traces for errors and deeper diagnostics.
- `--quiet`: suppress progress and warning output.
- `--json`: emit a machine-readable JSON payload.
- `--no-color`: disable color; iteration 1 output is ANSI-free in every mode.

`--verbose` and `--quiet` conflict. Machine modes write only their payload to stdout; progress, warnings, and artifact locations go to stderr. `NO_COLOR`, redirection, and narrow terminals never introduce ANSI output.

## Commands

```text
ariadne init
ariadne doctor [--config <path>]
ariadne run [--config <path>] [--task <id>]...
ariadne list [--format compact|wide|json|csv|markdown] [--output <path>]
ariadne report [--run <id-or-path>] [--output <path>]
```

`list --wide`, `--csv`, and `--md` are compatibility aliases. Global `--json` selects JSON list output. Conflicting list modes fail as usage errors. Output paths must remain within the canonical project root.

`report --run` accepts a run ID (resolved under `.ariadne/runs/<id>/run.json`) or a JSON path. Without it, Ariadne follows a valid `latest.json` pointer and falls back to the newest valid record if the pointer is missing or corrupt.

## Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | Success |
| 2 | Usage or configuration failure |
| 3 | Task selection failure |
| 4 | Repository precondition failure |
| 10 | Agent spawn/nonzero failure |
| 11 | Agent or verification timeout |
| 12 | Verification failure |
| 13 | Policy failure |
| 70 | Internal or persistence failure |
| 130 | SIGINT |
| 143 | SIGTERM |

For mixed tasks the exit code follows run-outcome precedence rather than the last task executed.
