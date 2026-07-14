# EKG Query and Write Efficiency Design

**Date:** 2026-07-14  
**Status:** Approved for implementation  
**Target:** `/Users/eric/engineering-knowledge-graph`

## 1. Problem

The current SQLite service is fast at the observed scale, but end-to-end agent usage is inefficient for large, long-lived Cases. The `s1-pro-compact` workload exposes the main failure mode: one Case contains 87 nodes, 143 edges, and 245 history events, so `get_case` returns about 337 KiB even though the database read itself completes in under one millisecond.

The design also has three scale-sensitive paths:

- `query_knowledge` stores an FTS5 projection but searches it with `%LIKE%`, producing a virtual-table scan instead of an FTS lookup.
- preflight loads and scores every project node in JavaScript.
- edge insertion reloads the complete Case edge set and rebuilds the graph for every cycle check.

Repeated CLI cold starts add roughly 100 ms per operation. The persistent MCP process avoids most of that fixed cost, but its large structured responses still consume transport and model context.

## 2. Goals

- Preserve existing project isolation, redaction, trust, and append-only history rules.
- Keep existing MCP tool names and existing callers valid.
- Make compact reads the default for agent workflows while retaining an explicit complete-detail path.
- Use SQLite indexes for candidate retrieval and Case history lookup.
- Reduce repeated write round trips without weakening per-item validation or idempotency.
- Add deterministic observability for operation duration and encoded response size without persisting raw inputs, logs, environment values, or unredacted excerpts.
- Upgrade existing schema-v5 databases without deleting or rewriting historical events.

## 3. Non-goals

- Replacing SQLite or WAL mode.
- Deleting, compacting, or semantically rewriting existing Cases and events.
- Changing promotion, regression, Guardrail, or evidence policy.
- Introducing background indexing services or remote infrastructure.
- Treating performance observations as trusted knowledge automatically.

## 4. Compatibility Strategy

The application contract gains optional read controls. Existing calls with no new fields remain valid, but default response projection becomes compact where returning complete history is unnecessarily expensive.

`get_case` accepts:

- `detail`: `summary | graph | full`, default `graph`.
- `historyLimit`: bounded positive integer, default `50`; used only for `full`.
- `historyBeforeSequence`: optional exclusive reverse cursor.

The `summary` projection returns Case metadata and bounded counts. The `graph` projection returns the current graph, evidence, artifacts, and command runs without event history. The `full` projection additionally returns one bounded history page plus a continuation cursor. Existing code that requires history must request `detail: full`; the browser adapter will do so explicitly where its timeline needs history.

`query_knowledge`, preflight, activity, and batch responses remain bounded and report truncation/cursors. MCP continues returning concise text plus structured results.

## 5. Query Design

### 5.1 Search

Text search uses FTS5 `MATCH` to retrieve candidate node rowids, then applies project, type, status, domain, fingerprint, file, and command constraints in project scope. User text is converted to a safely quoted prefix query; malformed or token-empty input falls back to a project-scoped literal substring search so compatibility is preserved.

Queries without text do not join `node_search`.

File and command matching remain semantically compatible in this change. Their current JSON substring fallback stays bounded by the candidate Case set; a later normalized reference table can replace it without changing the public contract.

### 5.2 Preflight

Preflight uses the same FTS candidate seam to find matching Case IDs, then applies the existing relevance scoring only to nodes in those Cases. Fingerprint matches are unioned directly. If tokenization yields no candidates, a bounded compatibility fallback scans project nodes.

All project Guardrails continue to be evaluated independently before the caller limit is applied. Candidate retrieval must never suppress a verified blocking Guardrail.

### 5.3 Case history

Schema version 6 adds nullable `case_id` to `events` plus `(project_id, case_id, sequence)` index. Existing rows are backfilled from the aggregate ID or redacted JSON payload. Every new Case-scoped event writes `case_id` explicitly; project-only events keep it null.

History reads use the indexed column and sequence cursor. The legacy JSON expression is retained only as a migration/backfill input, not as the steady-state query.

## 6. Write Design

### 6.1 Batch API

Add `record_checkpoint`, an idempotent application/MCP operation containing a bounded ordered array of existing write commands. The whole checkpoint executes in one outer SQLite transaction. Each item retains its existing operation ID/source key validation and returns its ordinary result. Any invalid item rolls back the complete checkpoint.

The first version supports Problem, Attempt, RootCause, Solution, Verification, Artifact, and Guardrail writes. Close/regression and command execution lifecycle remain separate because their side effects and trust boundaries differ.

Batch size and encoded payload are bounded by the existing payload policy and an explicit item maximum. No raw logs or environment values are accepted by this API.

### 6.2 Edge validation

Keep relation validation and cycle rejection. Replace full graph reconstruction with a reachability query from the proposed target to the proposed source, scoped by `case_id`. The insertion is rejected only when that path already exists. Add `(case_id, source_id)` and `(case_id, target_id)` indexes to support traversal.

### 6.3 Worktree alias

Register `/Users/eric/yqshunjian-ios-codex/.worktrees/s1-pro-compact` as an alias of the existing `yqshunjian-ios-codex` project through the public service/CLI workflow after code verification. This runtime-data mutation is separate from schema migration and source commits.

## 7. Response and Observability Design

MCP success responses retain their concise text. Structured results use the requested projection and page rather than the complete Case by default.

Introduce an in-process bounded operation metrics collector. Each service/MCP operation records only:

- operation name;
- success/error code;
- duration bucket or milliseconds;
- encoded response byte count;
- item count where applicable;
- timestamp.

Metrics contain no request bodies, node data, environment values, command output, or raw excerpts. A read-only diagnostic method returns bounded aggregate count, p50, p95, maximum duration, and maximum response bytes. Metrics are process-local in this release and are not written to SQLite.

## 8. Error Handling

- Invalid projection, cursor, limit, FTS text, or batch item returns the existing stable service error family.
- Batch failure identifies the zero-based item index and stable item kind without echoing its payload.
- Migration is transactional. A failed migration leaves schema version 5 intact.
- FTS fallback remains project-scoped and bounded.
- History cursors outside the available range return an empty page rather than an error.

## 9. Test Strategy

All behavior changes use red-green TDD.

Required regression tests:

1. Query plan/search behavior proves text search uses `MATCH`, no-text search avoids `node_search`, and results remain project-isolated.
2. Compact `get_case` omits history by default; `full` returns a bounded page and stable cursor; large-Case encoded output stays below an explicit fixture budget.
3. Preflight retrieves relevant old Cases beyond 100 unrelated Cases and never misses an unrelated newer verified blocking Guardrail.
4. Schema-v5 fixture migrates to v6, backfills `case_id`, and uses the new history index.
5. Reachability cycle detection accepts a valid edge and rejects a cycle without loading the whole edge set in application code.
6. A checkpoint writes several related records atomically, retries idempotently, rolls back on one invalid item, and preserves cross-project isolation.
7. Metrics expose only bounded aggregates and never contain secret sentinels or request/response bodies.
8. MCP and HTTP/browser contract tests request the appropriate detail projection.
9. A performance regression harness runs on a generated large Case with deterministic upper bounds generous enough for CI stability while asserting response-size and query-plan properties directly.

The release gate remains `npm run typecheck`, `npm test`, and `npm run build`, followed by `git diff --check`. Browser tests run if browser adapter behavior changes.

## 10. Delivery Order

1. Compact Case projections and indexed history migration.
2. FTS-backed query and candidate-based preflight.
3. Reachability edge validation and indexes.
4. Atomic checkpoint batch API.
5. Bounded operation metrics.
6. Adapter updates, documentation, full verification, runtime worktree alias registration.

Each slice must preserve explicit SQLite project scope in every read and mutation.

## 11. Acceptance Criteria

- Existing schema-v5 data opens and migrates without loss.
- Existing MCP tool names remain discoverable and existing write calls remain valid.
- Default large-Case response excludes history and is materially smaller than the current 337 KiB response.
- Full history is cursor-paginated and project-scoped.
- Text query execution uses FTS and no-text query avoids the FTS table.
- Preflight does not scan every project node in its normal candidate path and cannot miss blocking Guardrails.
- Batch writes are atomic and idempotent.
- Edge cycle detection remains correct with indexed reachability.
- Metrics reveal latency and response-size regressions without revealing durable or raw content.
- The required release commands pass before commit.
