# ADR: Unified daemon entry and protocol generation 2

Date: 2026-07-17  
Status: accepted

## Context

Codex workspace configuration and the project Fishbowl skill injected the legacy
`~/.fishbowl/data` directory while the installed LaunchAgent
owned the macOS platform-default store. Both descriptors advertised protocol 1.
A checkpoint carrying string `rootCause` and `solution` values reached the
daemon, which could report only `Request shape or operation is invalid`.

## Decision

- Codex configures one user-level stdio MCP entry with an absolute Node path and
  no `FISHBOWL_DATA_DIR`; the entry is required for MCP-enabled sessions.
- Codex performs all Fishbowl project resolution, preflight, query, and write
  operations as direct MCP tool calls. It never falls back to CLI, direct
  SQLite access, or a shell wrapper. CLI installation, diagnostics, and
  recovery remain human-operated boundaries.
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
must stop any existing writer first. An unavailable MCP server is now visible
to Codex instead of being masked by a sandbox-sensitive CLI fallback.

## Executed production record

The protocol-v2 build passed Rust debug/release workspace tests, Clippy with
warnings denied, TypeScript typecheck, 53 Vitest tests, and the production
build. Before installation, both SQLite stores were quiesced and backed up at
`backups/unified-entry-20260717-153746` with SHA-256 hashes. The unique
`yqshunjian-harmonyos` project was transactionally copied into the schema-v9
platform-default store: 20 Cases, 22 nodes/FTS rows, 45 events, seven operation
results, 18 source keys, one import preview, and 36 proposals. Foreign-key and
quick checks passed.

Two raw command logs were copied byte-identically into the platform-default
log root and their command/Artifact references were updated transactionally.
The old data directory is retained privately under the same backup directory
as `retired-legacy-data`; it is no longer an active entry. Installed acceptance
found one LaunchAgent at protocol 2, both iOS and HarmonyOS projects, and a
successful structured checkpoint. The malformed-string probe now fails locally
with RootCause field guidance instead of a daemon protocol error.
