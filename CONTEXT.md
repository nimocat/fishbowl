# Project Context

## Product

Engineering Knowledge Graph (EKG) is a local-first service for preserving the path from engineering failures through attempts, evidenced root causes, solutions, verification, and regressions. It never modifies registered client repositories by default.

## Architecture

- Migration target: Rust owns the knowledge engine; TypeScript is limited to
  MCP/HTTP adaptation and browser presentation. The current Node.js 22 core
  remains operational only until each Rust vertical slice passes parity.
- The Rust workspace begins with `ekg-core` (Unicode hierarchical routing and
  Guardrail policy) and `ekg-daemon` (read-only SQLite loading plus
  revision-cached retrieval).
- SQLite in WAL mode is the authoritative materialized store.
- The append-only `events` table is an audit log and live-update cursor, not a complete event-sourcing replay log.
- `KnowledgeService` is the transport-neutral application boundary.
- A persistent authenticated loopback daemon is the normal SQLite owner. Thin stdio MCP and CLI adapters call its versioned RPC allowlist; explicit `--embedded`/`--data-dir` remains for tests and recovery.
- The daemon also owns the read-only local HTTP/SSE Trace Bench, so browser views update from the same graph event cursor.
- Raw command logs live outside SQLite under `data/logs/<project-id>/`.
- `ImportService` owns explicit-source acquisition, candidate preview persistence, and selected transactional apply.
- `SnapshotService` owns versioned redacted export and validated deterministic project import.
- `createMcpServer(service)` is the protocol-only MCP boundary; it registers the project-aware tools against `KnowledgeServiceContract`, returns concise text plus structured results, and keeps a bounded content-free in-memory operation-metric window.
- `runStdioServer()` reserves stdout exclusively for MCP frames and proxies to the daemon; it opens SQLite only when an explicit embedded database path is injected for tests/recovery.
- `startTraceBenchServer({ service, port })` owns the native HTTP listener and always binds to `127.0.0.1`; HTTP and SSE reads use only `KnowledgeServiceContract`.
- Trace Bench static assets are allowlisted and copied to `dist/web`; the browser is read-only, uses native button nodes with SVG edges, and keeps a semantic trace visible alongside the graph.
- `ekg daemon install` registers a no-admin macOS LaunchAgent or Windows HKCU Run entry. Normal CLI calls auto-start once, authenticate with an owner-only 32-byte token, and retry once with a stable transport request ID.
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
- New databases carry the EKG SQLite `application_id`; schema version 7 adds digest-only relevance feedback, reviewed merge proposals, and explicit Case supersession while older files remain transactionally upgradeable.
- Promotion requires explicit `humanConfirmed` evidence, and Verification environments use a fixed non-secret allowlist.
- Import sources are explicit project-contained files or explicit Git `base..head` ranges; no service scans project trees.
- Portable snapshot imports never confer verified trust: verified Case, RootCause, Solution, SuccessCase, and Guardrail assertions become candidates, and blocking Guardrails therefore cannot arrive verified by assertion alone.
- Snapshot structure is iteratively bounded by depth, entry count, and encoded bytes before recursive redaction; exports enforce per-collection and aggregate byte limits.
- Snapshot import canonicalizes every non-external Artifact row and Artifact-node URI against destination project roots or the service data directory before mutation. External URIs remain unmaterialized references.
- Text queries use project-scoped FTS5 candidates. Preflight uses a bounded FTS candidate set for relevant knowledge while still evaluating the complete project-scoped Guardrail set before applying caller limits.
- The Rust migration replaces flat FTS-only candidate routing with a
  deterministic project → domain → prefix tree → Case path, followed later by
  deterministic k-core communities and bounded graph diffusion. Exact verified
  knowledge and blocking Guardrails remain independent of approximate recall.
- `get_case` defaults to the graph projection without history; summary and cursor-paged full projections keep large Case reads bounded.
- `record_checkpoint` atomically dispatches up to 25 existing write commands under one project and one idempotency key.
- `checkpoint_work` is the concise capture path: failures always record; routine successes may skip; optional RootCause/Solution assertions remain candidates until mixed verification.
- `finalize_work` atomically records a completed engineering delivery and its failed Attempts, RootCause, Solution, Verifications, commit, and merge disposition. It is idempotent, never executes Git or validation commands, and reuses Cases only through explicit `caseId` or an exact normalized fingerprint.
- Default Preflight is Case-ranked, explainable, cached by project event revision, capped at five cards, and compacted below 12 KiB.
- Case-scoped event writes persist explicit `case_id`; history paging and cycle prevention use indexed Case-local queries rather than JSON extraction or whole-graph loading.
- Command-log Artifacts retain validated digest algorithm, accepted and retained byte sizes, segment count, truncation state, and retained paths.
- Browser Case selection aborts the prior detail request and uses a monotonic token so stale same-project responses cannot replace the latest selection.
- MCP uses pinned `@modelcontextprotocol/sdk` 1.29.0 with Zod 3.25.76; tool inputs require explicit project references and apply protocol-level size/count constraints.
- MCP publishes concrete string item schemas for files and evidence; `finalize_work` mirrors application cross-field validation and reports precise field paths.
- HTTP requires a loopback `Host`, rejects non-matching `Origin`, emits no permissive CORS headers, and caps URLs, JSON bytes, graph Cases, and per-Case graph complexity.
- SSE resumes from `Last-Event-ID` before the `after` query cursor, polls project-filtered SQLite-backed activity in bounded batches, and emits `snapshot_required` rather than skipping an excessive gap.
- `ekg integrity` reports `check: "quick_check"`, exits nonzero on failure, and directs recovery into a separate data directory. The first release does not implement CLI `--help`; `README.md` is the command reference.
