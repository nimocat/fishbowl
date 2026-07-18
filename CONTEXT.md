# Project Context

## Product

Fishbowl (Fishbowl) is a local-first service for preserving the path from engineering failures through attempts, evidenced root causes, solutions, verification, and regressions. It never modifies registered client repositories by default.

## Architecture

- Migration target: Rust owns the knowledge engine; TypeScript is limited to
  MCP/HTTP adaptation and browser presentation. The current Node.js 22 core
  remains operational only until each Rust vertical slice passes parity.
- The Rust workspace contains `fishbowl-contracts` (strict versioned public read
  contracts), `fishbowl-core` (Unicode routing, trusted policy, deterministic
  project/domain/k-core hierarchy, structural summaries, and bounded
  trust-aware graph expansion), `fishbowl-storage`
  (project-scoped query-only schema-v9 reads), and `fishbowl-daemon` (revision-cached
  retrieval and a bounded persistent JSON-lines protocol). TypeScript's Rust
  adapter validates transport shape only and imports neither storage nor
  policy.
- SQLite in WAL mode is the authoritative materialized store.
- Schema v8 adds a task disk-growth ledger. Schema v9 adds a project-scoped persistent measurement cache for that ledger. Rust captures bounded metadata-only snapshots of known regenerable roots, stores only project-relative paths, byte counts, and directory modification stamps, marks cached and overlapping evidence for review, and never deletes candidates.
- The append-only `events` table is an audit log and live-update cursor, not a complete event-sourcing replay log.
- `KnowledgeService` is the transport-neutral application boundary.
- A persistent authenticated loopback daemon is the normal SQLite owner. Thin stdio MCP and CLI adapters call its protocol-generation-2 RPC allowlist; generation-1 descriptors are retired. Normal clients use the platform-default data directory, while explicit `--embedded`/`--data-dir` remains for tests and recovery only. One owner-only high loopback port is persisted as `daemon.port`; compatible upgrades adopt the last valid descriptor port, and every later start reuses it instead of requesting an ephemeral port.
- The daemon also owns the read-only local HTTP/SSE Trace Bench, so browser views update from the same graph event cursor.
- Raw command logs live outside SQLite under `data/logs/<project-id>/`.
- `ImportService` owns explicit-source acquisition, candidate preview persistence, and selected transactional apply.
- `SnapshotService` owns versioned redacted export and validated deterministic project import.
- `createMcpServer(service)` is the protocol-only MCP boundary; it registers the project-aware tools against `KnowledgeServiceContract`, returns concise text plus structured results, and keeps a bounded content-free in-memory operation-metric window.
- `runStdioServer()` reserves stdout exclusively for MCP frames and proxies to the daemon; it opens SQLite only when an explicit embedded database path is injected for tests/recovery.
- `startTraceBenchServer({ service, port })` owns the native HTTP listener and always binds to `127.0.0.1`; HTTP and SSE reads use only `KnowledgeServiceContract`.
- Trace Bench static assets are allowlisted and copied to `dist/web`; the browser is read-only, uses native button nodes with SVG edges, and keeps a semantic trace visible alongside the graph.
- `fishbowl daemon install` registers a no-admin macOS LaunchAgent or Windows HKCU Run entry, starts it when the platform registration is not immediate, and returns only after the descriptor on the persisted port passes authenticated readiness. Port conflicts fail with the port and configuration path rather than silently reallocating. Normal CLI calls auto-start once, authenticate with an owner-only 32-byte token, and retry once with a stable transport request ID.
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
- `fishbowl run` exits `78` only for a verified blocking Guardrail, maps spawn `ENOENT` to `127` and permission errors to `126`, and otherwise preserves the child exit or POSIX signal.
- Durable command excerpts are capped at 8 KiB and redacted. SQLite receives only canonical raw-log paths inside the selected project's roots or the service data directory, plus digest metadata; it never receives raw output or environment values.
- All project-scoped reads require an explicit project reference.
- Browser mutations are out of scope for the first release.
- IDs are UUIDs; timestamps are UTC ISO 8601 strings.
- New databases carry the Fishbowl SQLite `application_id`; schema version 9 adds persistent disk-measurement cache rows while retaining task observations, relevance, merge, and supersession data. Older files remain backup-first and transactionally upgradeable.
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
- `checkpoint_work` is the concise capture path: failures always record; routine successes may skip; optional RootCause/Solution assertions remain candidates until mixed verification. CLI checkpoint payloads are locally shape-validated so malformed structured assertions never collapse into a generic daemon protocol error.
- Native checkpoint/finalize responses omit absent optional IDs. The MCP adapter also strips legacy daemon `null` values for those optional fields before SDK output validation, so a successful idempotent write cannot be misreported as a response-shape failure during upgrades.
- `finalize_work` atomically records a completed engineering delivery and its failed Attempts, RootCause, Solution, Verifications, commit, and merge disposition. It is idempotent, never executes Git or validation commands, and reuses Cases only through explicit `caseId` or an exact normalized fingerprint.
- `finalize_work` is the single final-delivery write after commit and verification. `checkpoint_work` is reserved for real interruption, compaction, cross-day pause, or handoff; when a later finalization supplies the same Case, project-scoped exact-equivalent Attempt/RootCause/Solution nodes and their causal target are reused. Human Verification is never inferred from automation or device evidence.
- Default Preflight is Case-ranked, explainable, cached by project event revision, capped at five cards, and compacted below 12 KiB.
- Case-scoped event writes persist explicit `case_id`; history paging and cycle prevention use indexed Case-local queries rather than JSON extraction or whole-graph loading.
- Command-log Artifacts retain validated digest algorithm, accepted and retained byte sizes, segment count, truncation state, and retained paths.
- Browser Case selection aborts the prior detail request and uses a monotonic token so stale same-project responses cannot replace the latest selection.
- MCP uses pinned `@modelcontextprotocol/sdk` 1.29.0 with Zod 3.25.76; tool inputs require explicit project references and apply protocol-level size/count constraints.
- Codex uses the user-level Fishbowl server through direct MCP tool calls only. MCP tool discovery is its only Fishbowl discovery path: it never searches PATH, package scripts, or the filesystem for the CLI and never falls back to CLI, HTTP, direct SQLite access, or a shell wrapper. A missing namespace or tool is reported for human MCP configuration/client restart; CLI startup, diagnostics, and recovery are human-operated boundaries.
- Ambiguous idempotent writes are resolved through project-scoped `get_operation_result` before retry. It reads the existing durable operation ledger and requires no schema migration.
- `get_operation_metrics` with an explicit project returns that project's bounded 1,000-sample window owned by the persistent native daemon. The legacy empty request remains compatible and returns only the current MCP bridge session's bounded global aggregates; it never asks the daemon for cross-project metrics.
- `query_knowledge` is Case-diverse by default. MCP injects a five-item compact projection and exposes match explanations/diagnostics; `resultMode: "nodes"` explicitly expands multiple full matching nodes per Case. Text candidates are ordered by FTS relevance rather than creation time.
- Promotion responses retain machine-readable `missingRequirements` and actionable `nextActions`. `promote_root_cause` upgrades a confirmed candidate in place, and Case verification requires one connected RootCause→Solution→Verification chain.
- MCP publishes concrete string item schemas for files and evidence; `finalize_work` mirrors application cross-field validation and reports precise field paths.
- MCP structured output uses one exact `outcome` discriminated union: success is `{ok:true,result,error:null}` and failure is `{ok:false,result:null,error}`. This prevents contradictory or partially populated success/error envelopes from passing validation.
- HTTP requires a loopback `Host`, rejects non-matching `Origin`, emits no permissive CORS headers, and caps URLs, JSON bytes, graph Cases, and per-Case graph complexity.
- SSE resumes from `Last-Event-ID` before the `after` query cursor, polls project-filtered SQLite-backed activity in bounded batches, and emits `snapshot_required` rather than skipping an excessive gap.
- `fishbowl integrity` reports `check: "quick_check"`, exits nonzero on failure, and directs recovery into a separate data directory. Bare invocation, `help`, and standard help/version flags provide layered human-operated CLI guidance without daemon startup.
- Human-operated `fishbowl update` supports clean official `origin/main` source installations on macOS and Windows. It permits only fast-forward updates, tracks the deployed revision, backs up and restores `dist` around deployment, rebuilds and relinks fixed artifacts, refreshes the current-user daemon without macOS auto-spawn races, verifies authenticated daemon health, preserves the platform data directory, and never stashes, resets, switches branches, or overwrites local changes. `daemon stop` probes the authenticated daemon before signaling and waits for exit; Windows registration never signals a retained descriptor PID, while `daemon install` performs authenticated stop-and-wait before replacing a running daemon. macOS readiness polling is bounded to roughly 2.5 seconds. A narrow probe-to-signal race remains pending a native authenticated shutdown RPC. Agents remain MCP-only and never invoke the updater.
- The human CLI is self-describing: bare invocation and `help`/`--help`/`-h` return layered command guidance without daemon startup, every public leaf command has usage, standard version flags are supported, and failures retain JSON compatibility while adding `usage`, `hint`, and `help` recovery fields. Agent persistence remains MCP-only.
