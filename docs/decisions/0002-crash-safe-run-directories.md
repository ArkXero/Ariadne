# ADR 0002: Crash-safe Per-run Directories

Status: accepted

Each run receives an exclusively created directory containing its manifest and raw artifacts. Atomic checkpoint writes and a terminal-only latest pointer make interrupted work discoverable without allowing collisions or partial manifests to replace valid history.
