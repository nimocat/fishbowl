# ADR: Unified daemon entry and protocol generation 2

Date: 2026-07-17  
Status: accepted

## Context

Codex workspace configuration and the project EKG skill injected the legacy
`~/.engineering-knowledge-graph/data` directory while the installed LaunchAgent
owned the macOS platform-default store. Both descriptors advertised protocol 1.
A checkpoint carrying string `rootCause` and `solution` values reached the
daemon, which could report only `Request shape or operation is invalid`.

## Decision

- Codex configures one user-level stdio MCP entry with an absolute Node path and
  no `EKG_DATA_DIR`.
- Normal CLI, MCP, and LaunchAgent traffic uses the platform-default store.
  Alternate data directories are explicit test/recovery boundaries only.
- The public RPC generation is 2. Generation-1 descriptors are rejected.
- CLI checkpoint structured data is validated before daemon discovery or RPC;
  RootCause and Solution use the same typed public contract as MCP.
- Unique legacy project knowledge is merged backup-first into the default store
  before the legacy writer is retired. The legacy database is retained as a
  recovery artifact.

## Consequences

There is one production writer and one authoritative knowledge store. Stale
clients fail deterministically instead of talking to an incompatible daemon.
Malformed checkpoint data receives a field-specific local error. Isolated
recovery stores remain possible, but callers must opt into them explicitly and
must stop any existing writer first.
