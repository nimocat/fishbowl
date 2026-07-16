# Handoff

## Current Objective

Migrate EKG's knowledge engine to Rust and introduce deterministic hierarchical
retrieval. The active design is
`docs/specs/2026-07-16-rust-hierarchical-retrieval.md`.

## Rust Migration Status

Stages 0-1 are implemented on `codex/ekg-efficiency-rounds`. `ekg-core` provides a
project/domain Unicode prefix tree with Han bigram routing and explicit
Guardrail all-of/any-of semantics. `ekg-daemon` reads the existing core SQLite
tables in query-only mode, builds one cached tree per project, and invalidates
it using the project event revision.

The first 10,000-Case daemon benchmark exposed a correlated per-node domain
subquery: cold load was 10,010.541ms. Replacing it with one grouped CTE reduced
debug cold load to 1,147.123ms (88.54%). The release result is 177.349ms cold,
6.292µs warm p50, and 7.625µs warm p95. Pure release tree lookup is 1.417µs
p95. These numbers exclude MCP transport and full response construction.

`ekg-contracts` now owns strict protocol-v1 DTOs and complete public result
shapes for `queryKnowledge`, `preflight`, and `getCase`. Shared synthetic JSON
fixtures replay canonically in Rust and TypeScript. The Rust protocol keeps a
bounded request-ID cache, rejects changed-input reuse, emits sanitized stable
errors, and gives explicit restart/reinstall guidance for protocol mismatch.
Release replay p95 is 3µs over 1,000 iterations, excluding startup.

The Rust query path is still not wired into the installed daemon. Do not
duplicate retrieval or Guardrail policy in TypeScript while the remaining Rust
stages and installed lifecycle are completed.

Stage 2 now has a query-only `ekg-storage` repository that resolves project IDs
and canonical aliases, composes every current query filter, returns complete
Case/node records, preserves deterministic truncation/order, and does not
mutate schema-v7. A real persistent Rust process matched the TypeScript service
for 1,000 synthetic queries with zero mismatches (p95 0.135ms including local
transport). Complete 10,000-Case response p95 is 0.053ms; the bilingual tree
golden set reached Recall@5 100%.

Installed cutover is intentionally pending Stage 7: the current npm and
LaunchAgent installation does not package a native Rust binary. Do not point
production at a developer `target/release` path or require an environment
variable. Package and supervise the binary first, then close the Stage 2
cutover gate.

Stage 3 Rust policy and Preflight are complete. `ekg-core` owns promotion,
regression, staleness, Guardrail all/any evaluation, trusted blocking,
explainable ranking, and response compaction. `ekg-storage` evaluates every
project Guardrail independently of FTS candidate limits and caches by project
event revision with content-free metrics. The 10-case Guardrail golden set has
100% block recall and zero false positives. A real persistent process matched
TypeScript for 1,000 Preflights with zero mismatches; p95 was 0.113ms and every
default response stayed below 12KiB.

Stage 4 deterministic hierarchy is complete. Rust now builds
project → domain → deterministic k-core community → Case → node branches from
project-scoped schema-v7 reads. Structural summaries expose only counts,
statuses, fingerprints, files, commands, and verified conclusions with their
supporting Case IDs. Generated summaries are candidate-only and never confer
trust. Snapshot bytes are deterministic, and an upsert rebuilds only the
affected project/domain branch. On 10,000 synthetic Cases, replacing the
active-set scan with an ordered degree queue reduced release build from
392.692ms to 51.882ms and incremental rebuild from 38.245ms to 3.288ms.

Stage 5 bounded graph expansion is complete. Deterministic personalized
PageRank follows the selected project-local causal subgraph in both directions
with relation/trust-aware weights and explicit node, edge, and iteration
budgets. Results keep supporting paths. Exact evidence occupies a dominant
score tier; optional caller-provided similarity can refine but cannot displace
an exact verified match by itself. The ten-path golden set improved multi-hop
Recall@5 from 0% to 100%; a 10,000-node bounded release benchmark measured
21.746ms p95. HNSW remains intentionally absent because current bilingual and
multi-hop golden sets show no remaining recall gap that justifies an
approximate index.

Stage 6 is in progress and must not be cut over yet. Rust now covers individual
node/command/lifecycle writes plus aggregate checkpoint and finalization under
project ownership, operation/source idempotency, event/edge/FTS ordering,
recursive redaction, and injected rollback tests. A focused sentinel test
caught and fixed a `token: value` cross-word redaction leak. Project
registration/update, import/export, snapshot parity, and migration/backup/
recovery are still required. The installed TypeScript daemon remains the sole
writer.

The individual causal-node write set is now complete in Rust: RootCause,
Solution, Verification, Artifact, and Guardrail enforce project/Case ownership,
source/operation replay, graph relations, and specialized table rows in one
transaction. Verified RootCause requires human confirmation and failed-Attempt
evidence. Mixed automated plus confirmed human verification reuses the Rust
promotion policy and atomically verifies the Case and Solution. Aggregate and
lifecycle operations are still pending, so no cutover is allowed.

Case close/regression, relevance feedback, and reviewed merge operations are
also in Rust. Regression reuses fingerprint/applicability policy and only
mutates a verified Solution inside its declared boundary. Similarity creates
deterministic project-local proposals only; an explicit idempotent apply is
required before retiring the source Case and adding supersession state.
`record_checkpoint`, `checkpoint_work`, and `finalize_work` are now implemented
with one outer named savepoint and duplicate-free operation replay. Failed
aggregate validation rolls back every nested write; commit and merge inputs are
recorded only as bounded external facts. Portability/migration work remains
pending.

The implementation order, TDD fixtures, phase exit gates, rollout states, and
rollback rules are specified in
`docs/plans/2026-07-16-rust-core-migration-tdd.md`. Stage 6 transactional Rust
writes are the next executable slice; the plan alone does not authorize
production routing changes.

## Status

`finalize_work` is implemented across the application service, authenticated daemon allowlist, and MCP adapter. It atomically records failed and successful Attempts, candidate RootCause/Solution, bounded verification evidence, and external commit/merge fact Artifacts. It does not execute Git, tests, builds, or device validation. MCP collection items are concrete strings and cross-field errors identify their field paths. Final release-gate results follow after verification.

Final verification passed: typecheck; 195/195 Vitest across 37 files; 3/3 acceptance tests; production build; and `git diff --check`. The new acceptance journey uses two MCP clients through a real temporary authenticated daemon and verifies ordered Attempts, graph linkage, commit/merge facts, project isolation, bounded reads, and idempotent replay. Static inspection found no Git or subprocess execution in the `finalize_work` application/MCP path.

Post-merge installation exposed and fixed npm symlink execution: direct CLI/MCP detection now compares real paths, with a regression test. The current-user macOS LaunchAgent is installed and running; `ekg daemon status` is the authoritative way to retrieve its current dynamic Trace Bench URL.

The first real daemon startup also exposed the legacy default-directory migration gap. Startup now migrates a populated `~/.engineering-knowledge-graph/data/knowledge.db` into an empty platform-default store using SQLite backup and a destination backup, but never overwrites populated or explicitly selected stores. The installed database now exposes the existing `yqshunjian-ios-codex` project.

## Daemon/Relevance Disposition

1. Normal CLI/MCP calls no longer open SQLite. The daemon opens it once and uses a versioned explicit RPC allowlist with a 32-byte owner token, loopback Host/origin enforcement, 64 KiB request cap, and 1,000-entry same-process replay cache.
2. Preflight groups by Case, explains exact fingerprint/file/command/Guardrail/verified matches, returns at most five cards, compacts below 12 KiB, and caches by project event revision. Verified knowledge has no age-only expiry; candidates are down-ranked after 30/90 days.
3. `checkpoint_work` records a minimal failed/notable workflow in one transaction and one application idempotency key. Routine successes can return `routine-success`; inferred roots are never auto-verified.
4. Similarity creates proposals only. Applying a reviewed proposal explicitly retires the source Case and records `case_supersessions`; no text match auto-merges history.
5. macOS uses a user LaunchAgent. Windows uses only the current-user Run key. Uninstall preserves the database. The daemon starts Trace Bench and reports its `webUrl` through status.

## Query/Write Efficiency Disposition

1. Large Case reads default to a graph projection with no history; summary and full projections expose counts and cursor-paged history.
2. Event history uses `(project_id, case_id, sequence)` and Case writes populate `case_id` explicitly, including imported Cases.
3. Text query and preflight candidate discovery use FTS5 with explicit project ownership; verified Guardrails remain comprehensively evaluated.
4. Edge insertion checks only Case-local reachability with a recursive CTE and adjacency indexes.
5. `record_checkpoint` wraps up to 25 existing writes in one project-scoped transaction and caches the result by operation ID.
6. MCP metrics retain at most 1,000 scalar samples per process and expose aggregates only; no bodies, logs, environment values, or excerpts are retained.
7. Deterministic regression coverage asserts bounded response bytes plus actual use of the history and FTS indexes.

## Runtime Alias Verification

`/Users/eric/yqshunjian-ios-codex/.worktrees/s1-pro-compact` is registered in the configured user-local EKG database and resolves to project `fafff939-4e7a-42da-afc7-5782dde8947a`; no duplicate project was created.

## Final Path-Boundary Disposition

1. Command logs: `KnowledgeService` derives the allowed service data root from a file-backed database directory or accepts `{ dataRoot }` for in-memory use. Every `rawLogArtifact.paths` entry and legacy `rawLogPath` entry is canonicalized with the existing symlink-safe policy and must be inside that boundary or the selected project's canonical root/aliases.
2. MCP safety: MCP continues to delegate command recording to `KnowledgeService`, so callers cannot persist a trusted local command-log Artifact for `/etc`, a sibling project, or a symlink escape.
3. Snapshot safety: Before ID mapping or transaction entry, every non-external Artifact row URI and linked Artifact-node `data.uri` is canonicalized and checked against destination roots/service data. Invalid archives leave Cases, nodes, edges, Artifacts, events, and operation results unchanged.
4. External references: Explicitly external Artifact rows and linked nodes retain their URI unchanged and are not canonicalized, read, or copied.

## Remaining Re-review Disposition

1. Snapshot trust: Imported verified Case, RootCause, Solution, SuccessCase, and Guardrail records are downgraded to candidate; imported blocking Guardrails cannot block until trust is re-established locally.
2. Snapshot bounds: Export queries cap every collection at 10,001 rows and reject above 10,000; aggregate archives are capped at 1 MiB. Import performs iterative depth-64, structure-count, and encoded-byte validation before recursive redaction.
3. Preflight selection: Removed the 100-node project scan limit and Guardrail SQL limit. Project-scoped candidates are matched/scored first; applicable blocks are prioritized before applying the caller limit. Regressions cover 101 older unrelated Cases and an unrelated newer Guardrail at `limit: 1`.
4. RootCause evidence: Every `failedAttemptId` must resolve to an Attempt whose outcome is exactly `failed`; succeeded and inconclusive Attempts are rejected transactionally.
5. Raw-log metadata: `RawLogResult.artifact` now includes digest algorithm, accepted bytes, retained bytes, retained paths, segment count, and truncation. CLI and MCP pass the validated object through `recordCommandResult` into durable Artifact metadata.
6. Browser ordering: Case detail selection aborts the prior request and checks a monotonic selection token. Static and Chromium delayed-response tests cover stale same-project responses.

## Review Disposition

1. Stateful argv redaction: Added shared `redactArgv`; applied to Attempts, Verifications/evidence, command runs/events, snapshots/imports, indexing, and failed-run capture.
2. Environment allowlist: Verification accepts only `os`, `toolVersion`, `architecture`, `scheme`, `destination`, and `configuration`; arbitrary keys are rejected before persistence.
3. Failed `ekg run`: Nonzero/signal outcomes preserve the command result, reuse/create a fingerprinted candidate Problem, and append an unclassified failed Attempt using stable source keys.
4. Promotion: Requires an evidenced verified RootCause, automation/exception, explicit successful human `humanConfirmed` evidence, applicability, limitations, and successful-Attempt decisive difference. Verified RootCause assertion requires `humanConfirmed`; regression rejects non-verified Solutions.
5. Preflight: Scores task/argv/files/fingerprint terms, promotes matching Cases, ranks by relevance, then applies limits; unrelated Cases are excluded.
6. Run cwd: Canonical root/alias membership is validated before preflight, log creation, or spawn.
7. Snapshot import: Applies recursive redaction before validation/writes/search indexing; enforces 1 MiB, 10,000-entry-per-collection, and depth-64 bounds; graph cycle validation is iterative.
8. MCP: Includes `retired` and `SUPERSEDES`; close/regression are destructive, retry-safe only with required `operationId`; direct stdio uses the shared data-directory contract.
9. Database/data: Data directories are `0700`; database/WAL/SHM and logs are `0600` where supported; new databases carry application ID `0x454b4701`; schema v5 adds insert/update ownership triggers while v4 remains upgradeable.
10. Raw logs: Reject symlink log roots/project directories, cap writes, close descriptors on errors, recompute exact retained metadata after pruning, and persist local command-log Artifact metadata. Portable snapshots omit those local artifacts.
11. HTTP/SSE: Captures sequence before snapshot reads, closes tracked streams on shutdown, caps active streams at 32, terminates on backpressure, maps malformed encoding to 400, and bounds Case graph/history SQL reads.
12. Browser: Immediately closes/aborts on project switch, captures project/source identity to discard stale work, adds domain/confidence filtering, bounds rendered evidence/artifact/command details, and orders Attempts by `PRECEDED_BY`.
13. CLI/build: Tests no longer assume stdout/stderr cross-pipe ordering; build removes `dist` before compilation.
14. Lifecycle: Durable `command.started` and `command.completed` events expose running/interrupted command state.
15. Import proposals: JSON test reports emit grouped candidate Problem and failed Attempt proposals; apply creates one candidate Case and causal edge. No verified RootCause is inferred.

## RED/GREEN Evidence

- Final findings RED: command metadata accepted `/etc`, sibling-project, and symlink-escape paths; snapshot import accepted the same row URIs and then separately accepted an unsafe linked Artifact-node URI. Focused GREEN passed 50/50 across five files.
- Findings 1-5 RED: 6 expected failures across security, node-data, policy, service, and run-command tests; focused GREEN: 52/52.
- Findings 6-10 RED: 6 expected failures across CLI, storage, raw logs, snapshots, and MCP; focused GREEN: 34/34.
- Findings 11-14 RED: 6 expected failures across HTTP, browser, service, and CLI; focused GREEN: 31/31.
- Finding 15 RED: grouped import expected 3 proposals and one Case but received 2 proposals/two Cases; focused GREEN: 10/10 import tests.

## Verification

- Final review: `Spec: PASS`; `Quality: APPROVED`.
- `npm run typecheck`: passed.
- `npm test`: 149/149 passed across 21 files.
- `npm run test:acceptance`: 1/1 passed.
- `npm run test:browser`: 2/2 passed in Chromium.
- `npm run build`: passed; cleans `dist` first.
- Built-bin smoke: `integrity` returned `quick_check: ok`; `project list` returned `[]`.
- Final path-boundary rerun: typecheck passed; Vitest passed 149/149 across 21 files; acceptance passed 1/1; Chromium passed 2/2; build passed.
- `git diff --check`: passed after the final handoff update.

## Remaining Risks

- Browser confidence filtering is client-side over the server-bounded graph result; highly populated projects may need a first-class confidence query field later.
- Snapshot limits are intentionally conservative (1 MiB); larger legitimate archives require a future streaming/chunked format rather than raising unbounded materialization limits.
- Command start events are durable while interrupted commands have no completion row by design; consumers infer interruption from an unmatched start event.
