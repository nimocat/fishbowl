# EKG Rust Core Migration and TDD Plan

**Date:** 2026-07-16

**Status:** Approved direction; executable migration plan

**Branch:** `codex/ekg-efficiency-rounds`

**Related design:** `docs/specs/2026-07-16-rust-hierarchical-retrieval.md`

## 1. Objective

Move every EKG knowledge-engine responsibility from TypeScript to Rust without
losing existing knowledge, project isolation, redaction, idempotency, causal
history, promotion rules, Guardrail behavior, or local recovery.

After migration:

- Rust owns domain validation, storage, migrations, indexing, retrieval,
  ranking, graph traversal, policy, transactions, redaction enforcement,
  metrics, daemon lifecycle, and recovery.
- TypeScript owns only MCP schema adaptation and browser-facing presentation.
- SQLite remains the only authoritative durable knowledge store.
- Raw command logs remain outside SQLite under the existing retention policy.
- Exact verified knowledge and blocking Guardrails cannot be suppressed by
  approximate retrieval.

The migration will reuse proven algorithms, but it will not embed a complete
third-party RAG framework into the trusted core.

## 2. Non-negotiable invariants

Every phase must preserve all of the following:

1. Every read and mutation is explicitly project-scoped.
2. Worktree aliases resolve to exactly one registered project.
3. Raw logs, credentials, environment values, and unredacted excerpts never
   enter SQLite knowledge text.
4. Only a verified Guardrail with `enforcement=block` may block execution.
5. Candidate or imported assertions cannot become verified by assertion alone.
6. Operation ID and source-key retries are idempotent.
7. Case graph and append-only event mutations commit atomically.
8. Failed Attempts and regression history are never deleted.
9. No migration phase permits concurrent TypeScript and Rust writers.
10. A performance gain is rejected if recall, trust, isolation, or recovery
    regresses.

## 3. Current and target topology

### Current

```text
MCP / CLI / HTTP
        |
TypeScript daemon
        |
TypeScript KnowledgeService
        |
SQLite + FTS5
```

### Transitional

```text
MCP / browser presentation (TypeScript)
        |
versioned local RPC
        |
Rust daemon
  |-- Rust contracts and policy
  |-- Rust storage and transactions
  |-- Rust hierarchical retrieval
  `-- SQLite + revisioned in-memory indexes
```

### Final

```text
TypeScript MCP adapter       Browser UI
          \                   /
           versioned Rust daemon
                    |
         deterministic routing tree
                    |
       hierarchical knowledge communities
                    |
          bounded graph expansion
                    |
               SQLite
```

## 4. TDD operating model

Every behavior slice follows the same cycle.

### RED

- Add a language-neutral JSON fixture describing input, expected output,
  expected stable error, and expected durable effects.
- Replay it against the current TypeScript engine to establish compatibility.
- Add a Rust test that fails because the capability is missing.
- For improvements that intentionally differ, record the old output and the
  new expected outcome explicitly; never silently redefine parity.

### GREEN

- Implement the smallest Rust behavior that satisfies the fixture.
- Keep all SQLite queries explicitly scoped by project ID and Case ID.
- Keep the TypeScript production path unchanged until the phase exit gate.

### REFACTOR

- Remove duplicated Rust logic, add bounded types, and inspect query plans.
- Run debug correctness tests and release performance tests separately.
- Record before/after latency, response size, recall, and memory.

### SHADOW

- Send the same read request to TypeScript and Rust.
- Return the TypeScript result to the caller.
- Compare Rust results asynchronously using redacted digests and bounded
  mismatch metadata; never persist raw request text in metrics.
- Writes are never dual-executed.

### CUTOVER

- Enable Rust for one read operation at a time.
- Retain a bounded emergency fallback only while that phase is candidate.
- Remove fallback after an observation window and final acceptance.

## 5. Shared test assets

Create these assets before further cutover work:

```text
fixtures/contracts/
  projects.json
  query_knowledge.json
  preflight.json
  get_case.json
  checkpoint_work.json
  finalize_work.json
  import_export.json
  errors.json

fixtures/retrieval/
  bilingual_golden.json
  guardrail_golden.json
  multihop_golden.json
  global_local_golden.json
  regressions.json
```

Each fixture contains only redacted synthetic engineering knowledge. Required
golden-set categories:

- Chinese compound terms with inserted or omitted middle words.
- English exact, prefix, and paraphrased queries.
- fingerprint, file, symbol, test, and argv exact matches.
- schema/version applicability conflicts.
- candidate, verified, regressed, retired, and superseded Cases.
- blocking, warning, advisory, all-of, and any-of Guardrails.
- multi-hop Problem → Attempt → RootCause → Solution → Verification paths.
- unrelated large Cases that must not flood compact results.
- two projects containing identical text to prove isolation.

## 6. Measurement protocol

Every phase publishes one row in the efficiency ledger with:

- fixture revision and source commit;
- cold and warm p50/p95/p99;
- queue, execution, serialization, and transport duration;
- request and response bytes;
- Recall@1, Recall@3, Recall@5, MRR, and nDCG@5;
- exact-match recall and blocking-Guardrail recall;
- peak resident memory and index build duration;
- SQLite statements and write transactions per workflow;
- mismatch count against the compatibility oracle.

Debug tests use generous scheduler-safe budgets. Strict latency gates run only
in release mode and never concurrently with unrelated stress suites.

Initial reference points:

| Path | Cold | Warm p50 | Warm p95 |
| --- | ---: | ---: | ---: |
| Existing MCP observed end-to-end | n/a | 3–6s perceived | n/a |
| Existing service preflight | n/a | 17ms | 34ms |
| Initial Rust SQLite/tree, O(n²) | 10,010.541ms | 17.833µs | 22.084µs |
| Rust SQLite/tree after linear CTE, debug | 1,147.123ms | 17.750µs | 21.916µs |
| Rust SQLite/tree, release | 177.349ms | 6.292µs | 7.625µs |

## 7. Stage 0 — Baseline and Rust vertical slice

**Status:** Complete in commit `49c51fd`.

### Scope

- Rust workspace and core types.
- Unicode lexical routing and Han bigrams.
- Project → domain → prefix tree → Case routing.
- Guardrail all-of and explicit any-of semantics.
- Query-only SQLite reader and event-revision cache.
- 10,000-Case debug/release benchmark.

### Proven failure

The first SQLite loader used a correlated domain subquery for every node and
required 10,010.541ms for 10,000 Cases.

### Decisive fix

One grouped `case_domains` CTE plus a scoped join reduced debug cold load by
88.54%; release cold load is 177.349ms.

### Exit gate

- Rust native correctness and performance tests pass.
- Existing TypeScript tests remain green.
- Rust is query-only and cannot mutate production data.

## 8. Stage 1 — Contract ownership and parity harness

**Status:** Complete on `codex/ekg-efficiency-rounds` (2026-07-16)

**Goal:** Rust owns complete response and error contracts before it serves any
production operation.

### Files

```text
crates/ekg-contracts/
crates/ekg-core/src/error.rs
crates/ekg-daemon/src/protocol.rs
fixtures/contracts/
src/rust/contract-adapter.ts
tests/contracts/
```

### RED tests

1. Serialize every current public input/result/error from TypeScript into
   canonical fixture JSON.
2. Rust rejects unknown fields, invalid enum values, unbounded arrays, and
   project references containing both/neither ID and root.
3. Rust error responses match stable error codes without leaking raw inputs.
4. Rust output ordering is deterministic across repeated runs.
5. TypeScript decodes Rust results without interpreting policy or querying
   SQLite.

### GREEN implementation

- Add serde DTOs and bounded constructors.
- Version the daemon protocol independently from the SQLite schema.
- Add canonical JSON response fixtures and cross-language replay commands.
- Add request ID replay and stable error envelopes.

### Exit gate

- 100% fixture parity for read contracts.
- Zero policy or SQLite imports in the TypeScript Rust adapter.
- Achieved: `queryKnowledge`, `preflight`, and `getCase` request/result fixtures
  replay canonically in both languages; strict nested fields and bounded values
  are enforced before dispatch.
- Achieved: stable sanitized errors, version mismatch recovery guidance,
  deterministic serialization, and same-request replay with changed-input
  conflict rejection.
- Achieved: release replay p95 is 3µs across 1,000 iterations, excluding
  process startup (budget: 10ms).
- Production routing remains unchanged. Stage 2 must make Rust construct the
  complete `queryKnowledge` result before any read cutover.
- Contract replay p95 below 10ms excluding process startup.
- Protocol mismatch returns recovery guidance.

### Rollback

No production routing changes occur in this phase.

## 9. Stage 2 — `query_knowledge` read cutover

**Status:** Rust implementation and shadow gates complete; installed cutover
pending native binary packaging/lifecycle integration in Stage 7 (2026-07-16)

**Goal:** Rust returns the complete bounded `query_knowledge` result.

### RED tests

1. Exact fingerprint/file/symbol/command matches outrank lexical matches.
2. Chinese compound query recalls the expected Case.
3. Node type, status, domain, command, file, fingerprint, and limit filters are
   project-scoped and composable.
4. Two projects with identical text never cross-contaminate.
5. Results report stable truncation and deterministic ordering.
6. Existing schema-v7 database opens read-only without mutation.

### GREEN implementation

- Add `ekg-storage` read repository with prepared, scoped SQL.
- Replace the prototype character tree with a compressed radix/ART-equivalent
  only if benchmark evidence shows a material improvement.
- Return complete Case title and compact node records from Rust.
- Add project-revision incremental cache invalidation.

### Shadow gate

- Replay at least 1,000 synthetic and retained redacted queries.
- Exact-match parity: 100%.
- Existing expected results: Recall@5 no regression.
- New bilingual golden set: Recall@5 at least 95%.
- Rust response p95 below 50ms warm and 250ms cold for the large fixture.
- Mismatch diagnostics contain IDs and reason codes only.

Measured results:

- 1,000 TypeScript-vs-Rust persistent-process queries: 0 mismatches.
- Transport-inclusive p50 0.067ms, p95 0.135ms, p99 0.343ms.
- 20-query bilingual tree golden set: Recall@5 100%.
- 10,000-Case complete Rust response: cold 0.508ms, warm p50 0.034ms,
  p95 0.053ms, p99 0.125ms.
- Exact project/filter/order/truncation parity: 100% in the shadow corpus.
- Schema-v7 metadata remains unchanged under query-only access.

### Cutover

- Route `query_knowledge` to Rust.
- Keep TypeScript fallback disabled by default and available only through a
  temporary local recovery switch.
- Remove the fallback after the observation window.

The installed cutover remains open because the npm/LaunchAgent distribution
does not yet package a platform-native Rust binary. Silently depending on a
developer `target/release` path would violate installed-state acceptance. The
Rust response path is complete; Stage 7 must package, supervise, health-check,
and select it without environment setup before this cutover can close.

## 10. Stage 3 — Preflight, ranking, and Guardrails

**Status:** Complete in Rust; installed routing remains part of the Stage 7
native-daemon cutover (2026-07-16)

**Goal:** Rust owns all preflight selection and trusted blocking policy.

### RED tests

1. Every verified blocking Guardrail is evaluated independently of candidate
   limits and approximate retrieval.
2. Candidate or warning Guardrails never block.
3. Existing all-of semantics stay unchanged.
4. New `taskIncludesAny`, `commandIncludesAny`, and `fileIncludesAny` are
   explicit and deterministic.
5. Common terms such as `build`, `test`, and `fix` cannot displace exact file,
   command, fingerprint, or verified knowledge matches.
6. Default preflight remains at most five cards and below 12KiB.
7. Ranking explanations identify every score component.

### GREEN implementation

- Move promotion, regression, Guardrail, and relevance policy into `ekg-core`.
- Load verified Guardrails into an independent deterministic routing index.
- Add compact Case-card construction and response-size compaction in Rust.
- Add content-free cache-hit, candidate-count, card-count, and timing metrics.

### Exit gate

- Blocking Guardrail recall: 100%.
- Blocking false positives: 0 on the golden set.
- Preflight Recall@5 at least 95% and not below the TypeScript oracle.
- Warm daemon-internal p95 below 50ms.
- Default response below 12KiB.

Measured results:

- 1,000 TypeScript-vs-Rust Preflight requests: 0 mismatches.
- Persistent-process p50 0.045ms, p95 0.113ms, p99 0.235ms.
- Ten-case Guardrail golden set: blocking recall 100%, false positives 0.
- Bilingual/query shadow corpus: Recall@5 is not below TypeScript; exact
  semantic parity is 100%.
- Default result is capped at five cards and strictly below 12KiB.
- Project revision cache invalidates on the next event and reports only
  cache-hit, candidate/card counts, and execution duration.

## 11. Stage 4 — Deterministic hierarchical knowledge tree

**Status:** Complete in Rust; Stage 5 graph expansion is next (2026-07-16)

**Goal:** Support local and global engineering questions without scanning every
Case or relying on nondeterministic communities.

### RED tests

1. The same graph revision always produces byte-identical hierarchy metadata.
2. Incremental updates rebuild only affected project/domain branches.
3. A global query returns community summaries with supporting Case IDs.
4. A local query descends to concrete evidence without returning unrelated
   community contents.
5. Summary invalidation follows source revision changes.
6. No summary can confer verified status or replace primary evidence.

### GREEN implementation

- Add project → domain → deterministic k-core community → Case → node tree.
- Build structural summaries first: counts, statuses, fingerprints, files,
  commands, and verified conclusions.
- Add optional generated summaries only as versioned candidate artifacts.
- Keep summary creation outside the query hot path.

### Exit gate

- Hierarchy determinism: 100% over repeated builds.
- Incremental rebuild touches only expected branches.
- Global-query nDCG@5 materially exceeds flat lexical baseline.
- Every summary result carries supporting Case IDs.
- Release rebuild stays within the agreed memory and latency budget.

Measured results:

- Repeated snapshots are byte-identical and use JSON-safe ordered branch
  vectors rather than tuple-keyed maps.
- Project/domain upserts invalidate and rebuild only the affected branch.
- Global and local results always retain supporting Case IDs; generated
  summaries remain candidate-only and cannot become evidence.
- The read-only schema-v7 loader preserves project isolation and derives its
  revision from the project event sequence.
- Release 10,000-Case build is 51.882ms and one-domain incremental rebuild is
  3.288ms. Replacing an active-set scan with an ordered degree queue reduced
  these from 392.692ms and 38.245ms respectively.
- The structural-conclusion golden set reached nDCG@5 1.0 and exceeded the
  flat Case-text baseline.

## 12. Stage 5 — Bounded graph expansion and optional semantic recall

**Status:** Complete without an approximate index; Stage 6 writes are next
(2026-07-16)

**Goal:** Recover multi-hop and paraphrased knowledge after deterministic
candidate pruning.

### RED tests

1. Bounded PPR retrieves expected RootCause/Solution paths from a seed Problem.
2. Traversal cannot cross project boundaries.
3. Node/edge/iteration budgets terminate dense or adversarial subgraphs.
4. Approximate semantic results never outrank exact verified matches solely by
   similarity.
5. Disabling semantic retrieval produces a complete deterministic fallback.

### GREEN implementation

- Add PPR over the selected project-local subgraph.
- Add edge-type and trust-aware weights.
- Evaluate HNSW only after lexical/tree candidates and only if the golden set
  proves a recall gap.
- Evaluate late interaction only over a small bounded candidate set.

### Exit gate

- Multi-hop Recall@5 improves over Stage 4.
- Exact-match and Guardrail metrics do not regress.
- P95 remains inside the end-to-end target.
- Semantic index is optional, local, rebuildable, and non-authoritative.

Measured results:

- Deterministic personalized PageRank traverses project-local causal edges in
  both directions with relation and trust weights.
- Explicit node, edge, and iteration budgets terminate dense adversarial
  graphs; every hit carries its seed-to-node supporting path.
- The ten-path multi-hop golden set improved Recall@5 from 0% for exact seeds
  alone to 100% after graph expansion.
- A 10,000-node release benchmark with a 256-node/512-edge/20-iteration budget
  measured 21.746ms p95 over 100 runs.
- Exact matches occupy a dominant score tier. Optional similarity is bounded
  to tie refinement and cannot outrank exact verified evidence by itself.
- HNSW is intentionally deferred: bilingual Recall@5 is already 100% and the
  graph golden set closes the measured multi-hop gap, so an approximate index
  would add lifecycle and determinism cost without a demonstrated recall gain.

## 13. Stage 6 — Rust storage and transactional writes

**Status:** Implementation and offline acceptance complete; installed cutover
is deferred to Stage 7 daemon ownership (2026-07-16)

**Goal:** Rust becomes the only database writer.

### Migration rule

Reads may be shadowed. Writes may not. Each write operation switches atomically
from TypeScript to Rust only after its parity suite passes.

### Operation order

1. `record_command_started` / `record_command_result`
2. Problem and Attempt
3. RootCause, Solution, Verification, Artifact, Guardrail
4. `record_checkpoint`
5. `checkpoint_work`
6. `finalize_work`
7. close, regression, relevance, merge proposals
8. import/export and schema migration

### RED tests per operation

- success graph, edges, status, event order, and result;
- invalid payload with zero mutation;
- cross-project ownership rejection;
- operation-ID replay;
- source-key replay and type conflict;
- injected failure after every mutation step with full rollback;
- redaction sentinel absent from every SQLite projection;
- interrupted process recovery.

### GREEN implementation

- Add `ekg-storage` repositories and one explicit transaction boundary per
  application operation.
- Port schema migrations with backup-first recovery.
- Preserve existing IDs, timestamps, event sequence, and schema semantics.
- Add SQLite authorizer/query-only modes for read paths where appropriate.

### Exit gate

- Byte/semantic parity on exported project snapshots.
- Zero dual-writer paths.
- All rollback injection points leave the database unchanged.
- Existing production database migrates on a copy and passes integrity checks.
- Backup and downgrade/recovery instructions are executable.

Current progress:

- Added strict Rust Problem/Attempt write DTOs and a writable repository with
  one SQLite transaction per operation.
- Added command-start and command-result DTOs/writes with project-root
  ownership, argv/excerpt redaction, lifecycle events, and operation replay.
- Added RootCause, Solution, Verification, Artifact, and Guardrail writes with
  strict trust validation, causal edges, specialized evidence/artifact/
  guardrail rows, and Rust-owned mixed-verification promotion.
- Added Case close/regression, digest-only relevance feedback, deterministic
  project-local merge proposals, and explicit idempotent merge application.
- Added `record_checkpoint`, `checkpoint_work`, and `finalize_work` under one
  outer named savepoint while reusing the individually tested write methods.
  Invalid aggregates leave zero mutation, operation replay is duplicate-free,
  and commit/merge facts remain bounded external Artifacts rather than actions.
- Added project registration and atomic metadata/alias update with canonical
  existing-path ownership, recursive redaction, ordered events, and operation
  replay. Registration replay is resolved before creating another project.
- Added Rust-owned versioned project snapshot export/import with 1 MiB and
  10,000-record bounds, global UUID/reference/relation/cycle validation,
  deterministic SHA-256 remapping, trust downgrade, project-root redaction and
  safe local Artifact relocation. Invalid archives mutate nothing; retries are
  operation-idempotent.
- Added Rust-owned explicit-content preview/apply parsing for Markdown and JSON
  failed-test reports. It preserves parser-v1, 32-source/1 MiB bounds, preview
  expiry, source-digest staleness, proposal ownership, candidate-only writes,
  Problem/Attempt linkage, and operation replay. Rust daemon acquisition of
  explicit file/Git sources will feed this core API in Stage 7.
- Added backup-first Rust schema-v7 management: read-only quick/version
  inspection, v1-v7 compatibility migration, v6 event ownership backfill,
  transactional fault rollback, consistent backup, restore-to-new-path,
  permission hardening, and corrupt/newer byte preservation.
- Project ownership, operation-ID replay, source-key replay/type checks,
  event/edge/search ordering, recursive redaction, and four injected rollback
  points pass focused tests.
- A RED/GREEN cycle found that `token: value` could leak the value after a
  whitespace separator; stateful cross-token redaction now covers it.
- A consistent copy of the installed 2.9 MiB schema-v7 database passed Rust
  `quick_check` and typed export with exact SQL count parity: 59 Cases, 288
  nodes, 363 edges, 23 evidence rows, and 8 non-command-log Artifacts.
- No installed route has changed and there is no dual-write path. Stage 7 owns
  the one-time daemon/protocol cutover after native lifecycle acceptance.

## 14. Stage 7 — Rust daemon ownership and end-to-end metrics

**Goal:** Replace the Node daemon while retaining MCP/browser compatibility.

### RED tests

- loopback-only bind, Host/origin enforcement, bearer authentication;
- request limit, timeout, retry, replay, and protocol mismatch;
- daemon crash/restart with no partial mutation;
- macOS launchd and Windows current-user lifecycle contracts;
- queue, execution, serialization, and transmission metrics;
- MCP host delay reported separately from daemon time.

### GREEN implementation

- Rust authenticated loopback server and SSE event stream.
- Rust owns the SQLite connection pool and project cache.
- TypeScript MCP adapter becomes a stateless protocol translator.
- Browser consumes the stable HTTP/SSE contract.

### Exit gate

- Warm CLI end-to-end p95 below 250ms.
- Warm checkpoint p95 below 300ms.
- Daemon-internal preflight p95 below 100ms.
- No normal TypeScript process opens SQLite.
- Restart/replay acceptance passes on macOS and Windows.

Current progress:

- Added the native Axum/Tokio loopback transport with an IPv4 loopback-only
  listener, strict Host/same-origin checks, constant-time bearer comparison,
  a 64 KiB request bound, hardened response headers, and bounded replay state.
- Reused request IDs are replayed only for identical canonical requests;
  changed content returns `OPERATION_CONFLICT` without echoing the input.
- `Server-Timing` now separates queue, execution, and serialization inside the
  daemon. MCP-host delay remains a client-side measurement and is not falsely
  attributed to the Rust process.
- Four native transport tests pass, including a real ephemeral socket bind.
  The installed daemon is unchanged; full RPC ownership, SSE, lifecycle, and
  installed-state performance acceptance remain in this stage.
- Expanded the strict Rust protocol from the three-operation read seam to the
  complete daemon operation surface. `NativeDispatcher` exhaustively maps the
  typed enum to Rust repositories, so adding an operation without a Rust match
  is a compile error.
- Added Rust reads for project listing/resolution, recent activity, and bounded
  Case detail. A native HTTP integration test now performs schema creation,
  project registration, Problem write, Case read, project list, and knowledge
  query without any TypeScript callback.
- Full Rust workspace verification remains green after the ownership change.
  Controlled file/Git acquisition is the remaining import-boundary work before
  the native process/lifecycle cutover.
- Controlled import acquisition is now Rust-owned. File sources are
  canonicalized, limited to project root/aliases, checked as regular files,
  streamed under the aggregate 1 MiB bound, and decoded as UTF-8. Git accepts
  only an explicit safe `base..head`, resolves immutable commits, invokes Git
  without a shell, and bounds every captured stream.
- Preview persists canonical file or immutable Git hints. Apply reacquires from
  that database manifest after a fresh `NativeDispatcher`, so restart does not
  depend on process memory and changed source bytes still hit the core stale
  digest check. Path escape and option-injection fixtures are rejected without
  echoing source content.
- Added the production native process entry: it reads the token from a private
  file, opens/migrates through Rust, binds an ephemeral loopback port, and
  atomically publishes a mode-0600 descriptor and pid file. Graceful shutdown
  removes them; abrupt death is recovered by replacing the stale descriptor.
- A child-process acceptance test performs an authenticated write, kills the
  daemon, starts a new instance, replays the persisted operation, and proves a
  single Project remains. Request IDs remain transport-local while operation
  results survive restart.
- macOS LaunchAgent, Windows HKCU Run, CLI foreground, and automatic startup
  now invoke the native binary with explicit database/token/descriptor/pid
  arguments. No environment variable or Node daemon is used. The release build
  packages an executable arm64 binary at `dist/native/ekg-rust-core`.
- The same native loopback server now owns Trace Bench read routes and static
  assets: projects, bounded graph snapshots, activity, full Case detail, and
  SSE event polling. SSE honors `Last-Event-ID`, caps active streams at 32,
  emits bounded event batches one event at a time, and keeps browser delay out
  of daemon execution metrics.
- Browser endpoints retain loopback/same-origin and CSP protections. The
  process-level test loads a real static page and graph after a native write;
  the Router test verifies the SSE content type. The TypeScript web files are
  now assets only, not a database-serving process.

## 15. Stage 8 — Remove the TypeScript core

**Goal:** Enforce the final architecture mechanically.

### Removal targets

```text
src/application/knowledge-service.ts
src/application/query-planner.ts
src/application/relevance.ts
src/domain/* policy implementations
src/storage/* runtime implementations
TypeScript daemon SQLite ownership
```

Shared TypeScript DTOs may remain only when generated from or mechanically
validated against the Rust contract schema.

### Architecture tests

- TypeScript MCP and web directories cannot import SQLite, storage, graph,
  policy, ranking, or redaction implementation modules.
- Package dependency graph contains no `better-sqlite3` runtime dependency.
- Rust daemon is required for normal operation; embedded recovery is an
  explicit Rust mode.

### Final exit gate

- All historical TypeScript acceptance fixtures pass against Rust.
- Full migration, backup, restore, export/import, and daemon lifecycle tests
  pass.
- Performance and retrieval metrics meet every prior phase budget.
- Installed EKG passes a real project preflight, query, checkpoint, and
  Trace Bench smoke test.
- User explicitly approves production cutover.

## 16. Rollout states

Each operation moves through explicit states:

```text
ts-only
  → rust-shadow-read
  → rust-read-candidate
  → rust-read-default
  → rust-only
```

Write operations use only:

```text
ts-only
  → offline parity verified
  → rust-only
```

Rollback is allowed from Rust reads to TypeScript reads while both are
compatible. After Rust writes a newer schema, rollback means restoring the
pre-migration backup or using an explicitly compatible reader; it never means
letting an older TypeScript writer open a newer database.

## 17. Efficiency ledger and EKG recording

At the end of every stage:

1. Run the fixed release benchmark fixture.
2. Record the prior and new measurements with percentage change.
3. Record failed and inconclusive routes separately.
4. Attach the source commit and fixture revision.
5. Keep the Case candidate until real installed-daemon validation and human
   approval confirm the cutover.

Use EKG Case `087bb44e-24ac-4a75-a49b-3a7f74935f89` for the migration history.

## 18. Immediate next implementation slice

Stage 1 begins with these tasks:

1. Create `crates/ekg-contracts` with read DTOs and stable error codes.
2. Generate redacted query/preflight/get-case fixtures from the TypeScript
   contract tests.
3. Add Rust RED tests for strict input bounds and canonical output ordering.
4. Add a persistent Rust process protocol with request ID replay.
5. Add a TypeScript adapter that performs serialization only.
6. Run shadow parity without changing installed-daemon responses.

No hierarchy, vector, or write work begins until Stage 1 contract parity is
green. This prevents later phases from optimizing an unstable boundary.
