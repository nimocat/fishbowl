# Project Context

## Product

Engineering Knowledge Graph (EKG) is a local-first service for preserving the path from engineering failures through attempts, evidenced root causes, solutions, verification, and regressions. It never modifies registered client repositories by default.

## Architecture

- Node.js 22 and TypeScript.
- SQLite in WAL mode is the authoritative materialized store.
- The append-only `events` table is an audit log and live-update cursor, not a complete event-sourcing replay log.
- `KnowledgeService` is the transport-neutral application boundary.
- stdio MCP, CLI, local HTTP/SSE, and the browser are adapters around the same service.
- Raw command logs live outside SQLite under `data/logs/<project-id>/`.
- `ImportService` owns explicit-source acquisition, candidate preview persistence, and selected transactional apply.
- `SnapshotService` owns versioned redacted export and validated deterministic project import.
- `createMcpServer(service)` is the protocol-only MCP boundary; it registers the 22 design tools against `KnowledgeServiceContract` and returns concise text plus structured results.
- `runStdioServer()` owns SQLite/service/stdio lifecycle, uses `<EKG_DATA_DIR>/knowledge.db` (or the shared user-local data default), and reserves stdout exclusively for MCP protocol frames.
- `startTraceBenchServer({ service, port })` owns the native HTTP listener and always binds to `127.0.0.1`; HTTP and SSE reads use only `KnowledgeServiceContract`.
- Trace Bench static assets are allowlisted and copied to `dist/web`; the browser is read-only, uses native button nodes with SVG edges, and keeps a semantic trace visible alongside the graph.
- `ekg` is the executable adapter in `src/cli/main.ts`; its database is always `<data-directory>/knowledge.db`, where the directory comes from `--data-dir`, `EKG_DATA_DIR`, or the user-local default.
- `runCommand()` resolves and preflights before spawning exact argv with `shell: false`, inherited stdin, unchanged cwd, byte-preserving output teeing, rotating raw logs, and fail-open post-run recording.
- Existing on-disk databases are inspected read-only with SQLite `quick_check` and schema-version validation before writable pragmas or migrations. Corrupt and newer-schema files are preserved and surface stable backup/recovery/export guidance.

## Domain Terms

- **Case:** One troubleshooting effort and its immutable causal history.
- **Problem:** Observed symptom with an optional normalized fingerprint.
- **Attempt:** A concrete investigation or change and its outcome.
- **RootCause:** An evidenced causal explanation; automation cannot verify it by itself.
- **Solution:** A change with applicability, limitations, and a decisive difference from failures.
- **Verification:** Automated or human evidence.
- **SuccessCase:** The reusable verified path through a Case.
- **Guardrail:** Project-scoped preflight guidance; only verified `block` rules may prevent execution.
- **Artifact:** Metadata pointing to a retained file or external resource; raw bytes are not graph data.

## Conventions

- Public inputs use camelCase; SQLite columns use snake_case.
- Commands are argv arrays and execute with `shell: false`.
- CLI structured payloads use explicit JSON flags; query filter JSON cannot override project scope.
- `ekg run` exits `78` only for a verified blocking Guardrail, maps spawn `ENOENT` to `127` and permission errors to `126`, and otherwise preserves the child exit or POSIX signal.
- Durable command excerpts are capped at 8 KiB and redacted. SQLite receives only canonical raw-log paths inside the selected project's roots or the service data directory, plus digest metadata; it never receives raw output or environment values.
- All project-scoped reads require an explicit project reference.
- Browser mutations are out of scope for the first release.
- IDs are UUIDs; timestamps are UTC ISO 8601 strings.
- New databases carry the EKG SQLite `application_id`; schema version 5 adds project-ownership triggers while schema-v4 files remain upgradeable.
- Promotion requires explicit `humanConfirmed` evidence, and Verification environments use a fixed non-secret allowlist.
- Import sources are explicit project-contained files or explicit Git `base..head` ranges; no service scans project trees.
- Portable snapshot imports never confer verified trust: verified Case, RootCause, Solution, SuccessCase, and Guardrail assertions become candidates, and blocking Guardrails therefore cannot arrive verified by assertion alone.
- Snapshot structure is iteratively bounded by depth, entry count, and encoded bytes before recursive redaction; exports enforce per-collection and aggregate byte limits.
- Snapshot import canonicalizes every non-external Artifact row and Artifact-node URI against destination project roots or the service data directory before mutation. External URIs remain unmaterialized references.
- Preflight evaluates the complete project-scoped node and Guardrail candidate sets before applying caller limits.
- Command-log Artifacts retain validated digest algorithm, accepted and retained byte sizes, segment count, truncation state, and retained paths.
- Browser Case selection aborts the prior detail request and uses a monotonic token so stale same-project responses cannot replace the latest selection.
- MCP uses pinned `@modelcontextprotocol/sdk` 1.29.0 with Zod 3.25.76; tool inputs require explicit project references and apply protocol-level size/count constraints.
- HTTP requires a loopback `Host`, rejects non-matching `Origin`, emits no permissive CORS headers, and caps URLs, JSON bytes, graph Cases, and per-Case graph complexity.
- SSE resumes from `Last-Event-ID` before the `after` query cursor, polls project-filtered SQLite-backed activity in bounded batches, and emits `snapshot_required` rather than skipping an excessive gap.
- `ekg integrity` reports `check: "quick_check"`, exits nonzero on failure, and directs recovery into a separate data directory. The first release does not implement CLI `--help`; `README.md` is the command reference.
