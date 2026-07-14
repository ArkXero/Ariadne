# ADR 0001: Explicit Process Specifications

Status: accepted

Version 2 uses `{ kind: exec, file, args }` by default and requires `{ kind: shell, command }` for shell syntax. This preserves argument boundaries, makes preflight checks reliable, and avoids implicit platform shell behavior. Legacy strings remain supported only through the v1 compatibility adapter.
