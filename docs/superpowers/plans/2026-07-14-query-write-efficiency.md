# Fishbowl Query and Write Efficiency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make large Fishbowl Cases cheap to retrieve, use indexed candidate search, preserve correct cycle checks, support atomic checkpoint writes, and expose content-safe performance aggregates.

**Execution status (2026-07-14):** Tasks 1-7 are implemented and verified with focused red-green evidence, the complete release gate, review, and successful `s1-pro-compact` alias resolution. The final source commit is pending.

**Architecture:** Schema v6 adds indexed Case ownership to events and adjacency indexes. `KnowledgeService` gains compact Case projections, FTS candidate retrieval, indexed history paging, transactional checkpoint dispatch, and an isolated in-memory metrics collector. MCP and HTTP remain adapters over the same contract and explicitly request only the projection they need.

**Tech Stack:** Node.js 22, TypeScript 5.8, better-sqlite3, SQLite STRICT tables/FTS5/WAL, Zod 3, Vitest, MCP SDK 1.29.0.

## Global Constraints

- Preserve explicit project scope in every SQLite query and mutation.
- Never persist raw logs, environment values, request bodies, response bodies, or unredacted excerpts in SQLite or metrics.
- Keep existing MCP tool names and existing write-call inputs valid.
- Preserve promotion, regression, Guardrail, evidence, redaction, and append-only event semantics.
- Migrate schema-v5 databases transactionally without deleting or rewriting historical event payloads.
- All behavior changes follow red-green TDD.
- Required final gate: `npm run typecheck`, `npm test`, `npm run build`, and `git diff --check`.

---

## File Structure

- `src/storage/schema.ts`: schema-v6 event ownership/backfill and edge adjacency indexes.
- `src/events/event-journal.ts`: event row mapping with optional Case ownership.
- `src/application/contracts.ts`: projection, history page, checkpoint, and metric contracts.
- `src/application/query-planner.ts`: safe FTS expression construction and candidate Case lookup helpers.
- `src/application/operation-metrics.ts`: bounded content-free in-memory aggregates.
- `src/application/knowledge-service.ts`: compact reads, preflight candidates, checkpoint transaction, and metrics integration.
- `src/cases/case-graph.ts`: indexed recursive reachability cycle check.
- `src/mcp/server.ts`: compatible optional inputs and new checkpoint/metrics tools.
- `src/http/server.ts`, `src/web/app.js`: projection-aware reads.
- `tests/performance/query-write-efficiency.test.ts`: deterministic query-plan and response-size regression harness.
- `CONTEXT.md`, `README.md`, project plans/log/handoff, and ADR: durable project memory.

---

### Task 1: Schema-v6 Indexed Case History

**Files:**
- Modify: `src/storage/schema.ts`
- Modify: `src/events/event-journal.ts`
- Modify: `src/application/knowledge-service.ts`
- Test: `tests/storage/database.test.ts`
- Test: `tests/application/knowledge-service.test.ts`

**Interfaces:**
- Produces `events.case_id TEXT NULL`, `events_project_case_sequence_idx`, `edges_case_source_idx`, and `edges_case_target_idx`.
- Every new Case-scoped event receives an explicit Case ID; project-only events receive null.

- [ ] **Step 1: Write failing migration and history-plan tests**

Add a schema-v5 fixture, open it, and assert:

```ts
expect(database.pragma('user_version', { simple: true })).toBe(6)
expect(database.prepare('SELECT case_id FROM events WHERE aggregate_id = ?').get(caseId))
  .toEqual({ case_id: caseId })
expect(indexNames(database, 'events')).toContain('events_project_case_sequence_idx')
expect(indexNames(database, 'edges')).toEqual(expect.arrayContaining([
  'edges_case_source_idx', 'edges_case_target_idx',
]))
```

Add a Case-history query-plan assertion that contains `events_project_case_sequence_idx` and does not contain `json_extract`.

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/storage/database.test.ts tests/application/knowledge-service.test.ts`

Expected: schema version is 5, `events.case_id` is absent, and history still uses `json_extract`.

- [ ] **Step 3: Implement the migration**

Add a migration with:

```sql
ALTER TABLE events ADD COLUMN case_id TEXT REFERENCES cases(id) ON DELETE RESTRICT;
UPDATE events
SET case_id = CASE
  WHEN EXISTS (SELECT 1 FROM cases WHERE cases.id = events.aggregate_id
               AND cases.project_id = events.project_id)
    THEN aggregate_id
  ELSE json_extract(payload, '$.caseId')
END
WHERE case_id IS NULL
  AND (EXISTS (SELECT 1 FROM cases WHERE cases.id = events.aggregate_id
               AND cases.project_id = events.project_id)
       OR EXISTS (SELECT 1 FROM cases
                  WHERE cases.id = json_extract(events.payload, '$.caseId')
                    AND cases.project_id = events.project_id));
CREATE INDEX events_project_case_sequence_idx
  ON events(project_id, case_id, sequence);
CREATE INDEX edges_case_source_idx ON edges(case_id, source_id);
CREATE INDEX edges_case_target_idx ON edges(case_id, target_id);
```

Change event append helpers to accept `caseId?: string`, insert it explicitly, and pass the known Case ID at Case/node/edge/evidence/command/status call sites.

- [ ] **Step 4: Replace history expression with indexed paging**

Use:

```sql
SELECT * FROM events
WHERE project_id = ? AND case_id = ? AND sequence < ?
ORDER BY sequence DESC
LIMIT ?
```

Use `Number.MAX_SAFE_INTEGER` when no cursor is supplied.

- [ ] **Step 5: Run GREEN and commit**

Run: `npm test -- tests/storage/database.test.ts tests/application/knowledge-service.test.ts`

Expected: both files pass.

Commit: `feat: index case event history`

---

### Task 2: Compact Case Projections and History Pagination

**Files:**
- Modify: `src/application/contracts.ts`
- Modify: `src/application/knowledge-service.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/http/server.ts`
- Modify: `src/web/app.js`
- Test: `tests/application/knowledge-service.test.ts`
- Test: `tests/mcp/server.test.ts`
- Test: `tests/http/server.test.ts`
- Test: `tests/browser/app.test.ts`

**Interfaces:**
- Produces:

```ts
export type CaseDetailLevel = 'summary' | 'graph' | 'full'
export interface GetCaseInput {
  project: ProjectReference
  caseId: string
  detail?: CaseDetailLevel
  historyLimit?: number
  historyBeforeSequence?: number
}
export interface CaseCounts {
  nodes: number
  edges: number
  evidence: number
  artifacts: number
  commandRuns: number
  history: number
}
export interface CaseDetail extends CaseSnapshot {
  detail: CaseDetailLevel
  counts: CaseCounts
  history: KnowledgeEvent[]
  historyNextBeforeSequence: number | null
}
```

For `summary`, inherited graph arrays and evidence/artifact/command arrays are empty.

- [ ] **Step 1: Write failing projection tests**

Create a Case with more than 50 events and assert:

```ts
const graph = service.getCase({ project, caseId })
expect(graph.detail).toBe('graph')
expect(graph.nodes.length).toBeGreaterThan(0)
expect(graph.history).toEqual([])

const full = service.getCase({ project, caseId, detail: 'full', historyLimit: 10 })
expect(full.history).toHaveLength(10)
expect(full.historyNextBeforeSequence).toBe(full.history[0]?.sequence ?? null)

const summary = service.getCase({ project, caseId, detail: 'summary' })
expect(summary.nodes).toEqual([])
expect(summary.counts.nodes).toBeGreaterThan(0)
```

Assert a generated large-Case graph response stays below 128 KiB and a full ten-event page stays below 192 KiB.

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/application/knowledge-service.test.ts`

Expected: projection fields are absent and default history is non-empty.

- [ ] **Step 3: Implement bounded projections**

Validate `historyLimit` with `boundedLimit`; reject non-positive/non-integer cursors. Run counts in explicit project scope. `summary` returns empty collections; `graph` loads materialized collections without history; `full` adds the indexed history page and reverses it for chronological presentation.

- [ ] **Step 4: Update adapters test-first**

Add MCP inputs:

```ts
detail: z.enum(['summary', 'graph', 'full']).optional(),
historyLimit: z.number().int().min(1).max(100).optional(),
historyBeforeSequence: z.number().int().positive().optional(),
```

Make `/api/v1/graph` request `detail: 'graph'`. Make `/api/v1/cases/:id` request `detail: 'full'`, accept bounded `history_limit` and `history_before`, and return the cursor. Browser Case fetches request `history_limit=50`.

Run adapter RED before implementation:

`npm test -- tests/mcp/server.test.ts tests/http/server.test.ts tests/browser/app.test.ts`

Expected: schema/route assertions fail, then pass after implementation.

- [ ] **Step 5: Run GREEN and commit**

Run: `npm test -- tests/application/knowledge-service.test.ts tests/mcp/server.test.ts tests/http/server.test.ts tests/browser/app.test.ts`

Expected: all focused tests pass.

Commit: `feat: paginate compact case details`

---

### Task 3: FTS Candidate Search and Bounded Preflight

**Files:**
- Create: `src/application/query-planner.ts`
- Modify: `src/application/knowledge-service.ts`
- Create: `tests/application/query-planner.test.ts`
- Modify: `tests/application/knowledge-service.test.ts`
- Create: `tests/performance/query-write-efficiency.test.ts`

**Interfaces:**
- Produces:

```ts
export function buildFtsQuery(text: string): string | null
export function matchingCaseIds(
  database: Database.Database,
  projectId: string,
  text: string,
  limit: number,
): string[]
```

- [ ] **Step 1: Write failing FTS safety and plan tests**

```ts
expect(buildFtsQuery('AVFoundation streaming'))
  .toBe('"AVFoundation"* AND "streaming"*')
expect(buildFtsQuery('" OR *')).toBeNull()
expect(buildFtsQuery('羽球 算法')).toBe('"羽球"* AND "算法"*')
```

Use `EXPLAIN QUERY PLAN` to assert text lookup contains an FTS `M` index and no-text service queries do not mention `node_search`.

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/application/query-planner.test.ts tests/performance/query-write-efficiency.test.ts`

Expected: missing module and current full-scan plan failure.

- [ ] **Step 3: Implement safe FTS candidates**

Normalize terms with Unicode letters/numbers plus `_.-`, escape quotes by doubling, join quoted prefix terms with `AND`, and query:

```sql
SELECT DISTINCT nodes.case_id
FROM node_search
JOIN nodes ON nodes.id = node_search.node_id
JOIN cases ON cases.id = nodes.case_id
WHERE node_search MATCH ? AND cases.project_id = ?
ORDER BY bm25(node_search), nodes.created_at DESC
LIMIT ?
```

Text query uses candidate Case IDs. No-text query joins only `cases` and `nodes`. Token-empty text uses the existing project-scoped literal fallback with a hard candidate bound.

- [ ] **Step 4: Move Preflight behind candidate selection**

Retrieve candidate Case IDs from task text, changed files, argv, and fingerprint. Load nodes only for those Cases, then retain Case scoring/order. Continue querying and evaluating every project Guardrail separately. Add a regression with 101 unrelated Cases, one old relevant Case, and one newer verified blocking Guardrail.

- [ ] **Step 5: Run GREEN and commit**

Run: `npm test -- tests/application/query-planner.test.ts tests/application/knowledge-service.test.ts tests/performance/query-write-efficiency.test.ts`

Expected: FTS plan, isolation, old relevant Case, and complete Guardrail checks pass.

Commit: `perf: use indexed knowledge candidates`

---

### Task 4: Indexed Reachability Cycle Validation

**Files:**
- Modify: `src/cases/case-graph.ts`
- Test: `tests/cases/case-graph.test.ts`
- Test: `tests/performance/query-write-efficiency.test.ts`

**Interfaces:**
- Produces private `wouldCreateCycle(caseId, sourceId, targetId): boolean` backed by a recursive CTE.

- [ ] **Step 1: Write failing correctness and instrumentation tests**

Build `Problem <- Attempt <- Attempt`; assert a back edge is rejected and a disconnected valid edge is accepted. Use a database trace seam to assert `addEdge` no longer executes `SELECT source_id, target_id FROM edges WHERE case_id = ?`.

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/cases/case-graph.test.ts tests/performance/query-write-efficiency.test.ts`

Expected: full edge-set query assertion fails.

- [ ] **Step 3: Implement recursive reachability**

```sql
WITH RECURSIVE reachable(id) AS (
  SELECT target_id FROM edges WHERE case_id = ? AND source_id = ?
  UNION
  SELECT edges.target_id
  FROM edges JOIN reachable ON edges.source_id = reachable.id
  WHERE edges.case_id = ?
)
SELECT 1 FROM reachable WHERE id = ? LIMIT 1
```

Traverse from proposed target toward proposed source. Preserve endpoint ownership and relation validation before reachability.

- [ ] **Step 4: Run GREEN and commit**

Run: `npm test -- tests/cases/case-graph.test.ts tests/performance/query-write-efficiency.test.ts`

Expected: both tests pass.

Commit: `perf: index graph cycle checks`

---

### Task 5: Atomic Record Checkpoints

**Files:**
- Modify: `src/application/contracts.ts`
- Modify: `src/application/knowledge-service.ts`
- Modify: `src/mcp/server.ts`
- Test: `tests/application/knowledge-service.test.ts`
- Test: `tests/mcp/server.test.ts`

**Interfaces:**
- Produces:

```ts
export type CheckpointWrite =
  | { kind: 'problem'; input: Omit<RecordProblemInput, 'project'> }
  | { kind: 'attempt'; input: Omit<RecordAttemptInput, 'project'> }
  | { kind: 'rootCause'; input: Omit<RecordRootCauseInput, 'project'> }
  | { kind: 'solution'; input: Omit<RecordSolutionInput, 'project'> }
  | { kind: 'verification'; input: Omit<RecordVerificationInput, 'project'> }
  | { kind: 'artifact'; input: Omit<RecordArtifactInput, 'project'> }
  | { kind: 'guardrail'; input: Omit<RecordGuardrailInput, 'project'> }

export interface RecordCheckpointInput {
  project: ProjectReference
  operationId: string
  writes: CheckpointWrite[]
}
export interface RecordCheckpointResult {
  results: Array<NodeWriteResult | ArtifactWriteResult>
  created: boolean
}
```

- [ ] **Step 1: Write failing atomicity/idempotency tests**

Assert a valid checkpoint commits all writes, retry returns `created: false`, and a checkpoint whose second item violates project ownership leaves Case/node/edge/event/operation counts unchanged.

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/application/knowledge-service.test.ts tests/mcp/server.test.ts`

Expected: `recordCheckpoint` and `record_checkpoint` are absent.

- [ ] **Step 3: Implement the outer transaction**

Require 1–25 writes and validate the complete payload before mutation. Resolve project once. Inside one outer transaction, check checkpoint idempotency, dispatch each item to the existing write method with the resolved project ID, add only `{ itemIndex, kind }` to stable error details, store the checkpoint result, and return it. Nested transactions remain savepoints.

- [ ] **Step 4: Register strict MCP union**

Register `record_checkpoint` with a seven-kind discriminated union, maximum 25 items, idempotent annotations, and stable error translation. Exclude command-run and environment payloads.

- [ ] **Step 5: Run GREEN and commit**

Run: `npm test -- tests/application/knowledge-service.test.ts tests/mcp/server.test.ts`

Expected: atomicity, idempotency, validation, isolation, and discovery pass.

Commit: `feat: record atomic knowledge checkpoints`

---

### Task 6: Content-Safe Operation Metrics

**Files:**
- Create: `src/application/operation-metrics.ts`
- Modify: `src/application/contracts.ts`
- Modify: `src/application/knowledge-service.ts`
- Modify: `src/mcp/server.ts`
- Create: `tests/application/operation-metrics.test.ts`
- Modify: `tests/mcp/server.test.ts`

**Interfaces:**
- Produces:

```ts
export interface OperationMetricSample {
  operation: string
  ok: boolean
  errorCode: string | null
  durationMs: number
  responseBytes: number
  itemCount: number | null
  occurredAt: string
}
export interface OperationMetricAggregate {
  operation: string
  count: number
  errors: number
  p50DurationMs: number
  p95DurationMs: number
  maxDurationMs: number
  maxResponseBytes: number
}
export class OperationMetrics {
  record(sample: OperationMetricSample): void
  aggregates(): OperationMetricAggregate[]
}
```

- [ ] **Step 1: Write failing bounded/redaction tests**

Record more than 1,000 approved scalar samples. Assert only the newest 1,000 contribute, percentiles are deterministic, and aggregate JSON contains neither a request sentinel nor response-body keys.

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/application/operation-metrics.test.ts`

Expected: missing metrics module.

- [ ] **Step 3: Implement a fixed-size collector**

Store a 1,000-sample ring. Sort copied duration arrays for nearest-rank p50/p95. Clamp duration/byte/count values to non-negative safe integers. Do not accept arbitrary metadata.

- [ ] **Step 4: Instrument MCP invocation**

Measure with `performance.now()`, encode only the returned result to calculate bytes, derive item count from known top-level arrays, and record stable error codes. Add read-only `get_operation_metrics` returning aggregates, never samples or payloads.

- [ ] **Step 5: Run GREEN and commit**

Run: `npm test -- tests/application/operation-metrics.test.ts tests/mcp/server.test.ts`

Expected: collector and protocol aggregate tests pass with secret-sentinel absence.

Commit: `feat: expose safe Fishbowl operation metrics`

---

### Task 7: Documentation, Alias, Review, and Release Gate

**Files:**
- Modify: `CONTEXT.md`
- Modify: `README.md`
- Modify: `docs/implementation-plan.md`
- Modify: `docs/agent-log.md`
- Modify: `docs/handoff.md`
- Modify: `docs/decisions/ADR-20260713-modular-local-service.md`

**Interfaces:**
- Consumes all prior contracts.
- Produces current operating guidance and a registered `s1-pro-compact` alias in the configured runtime database.

- [ ] **Step 1: Update durable documentation**

Document schema v6, compact/full Case reads, history cursors, FTS fallback, checkpoint limits/atomicity, content-safe metrics, persistent MCP preference, and performance regression commands.

- [ ] **Step 2: Run the focused performance loop**

Run: `npm test -- tests/performance/query-write-efficiency.test.ts`

Expected: FTS uses `MATCH`; compact response budgets pass; edge insertion avoids full graph loading.

- [ ] **Step 3: Run complete verification**

Run separately:

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

Run `npm run test:browser` because HTTP/browser Case behavior changes.

Expected: all commands exit 0 with zero failed tests.

- [ ] **Step 4: Review the complete diff**

Invoke the `review` skill. Check project scoping, migration safety, redaction, response compatibility, pagination, batch rollback, FTS fallback, and performance-test determinism. Fix actionable findings test-first and rerun affected tests.

- [ ] **Step 5: Register and resolve the worktree alias**

Run:

```bash
FISHBOWL_DATA_DIR=/Users/eric/.fishbowl/data \
node dist/cli/main.js project update \
  --project fafff939-4e7a-42da-afc7-5782dde8947a \
  --add-alias /Users/eric/yqshunjian-ios-codex/.worktrees/s1-pro-compact
```

Then:

```bash
FISHBOWL_DATA_DIR=/Users/eric/.fishbowl/data \
node dist/cli/main.js project resolve \
  --root /Users/eric/yqshunjian-ios-codex/.worktrees/s1-pro-compact
```

Expected: project ID `fafff939-4e7a-42da-afc7-5782dde8947a` is returned and no second project is created.

- [ ] **Step 6: Commit final implementation**

Stage only plan-owned files. Preserve the unrelated untracked agent-knowledge specification.

Commit: `feat: improve Fishbowl query and write efficiency`
