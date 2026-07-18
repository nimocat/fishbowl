# Handoff

## Checkpoint Output Compatibility Fix (2026-07-18)

`checkpoint_work` no longer reports an MCP output validation failure after a successful native write. Rust omits absent optional checkpoint/finalize fields, and TypeScript normalizes legacy daemon nulls at the MCP boundary. Regression coverage exercises the exact daemon-shaped null response and the canonical Rust JSON shape. Full TypeScript and Rust suites, typecheck, rustfmt, and production build pass. This is response-only compatibility work; it does not replay or modify the planning checkpoint already saved through lower-level tools.

## Task Disk Ledger Follow-up (2026-07-17)

Branch `codex/fishbowl-disk-ledger` is merged and installed at schema v8. The implementation records start/final byte snapshots for allowlisted regenerable directories, computes path-level growth, marks overlapping sessions shared, and exposes read-only cleanup candidates without deletion. Rust Debug/Release, migration, native HTTP, TypeScript, MCP/CLI, production-copy, and installed tests pass. The installed YQSK finish scan reached its 250,000-entry cap and returned in 6.73 seconds; disk lifecycle RPCs therefore use a bounded 15-second client deadline, readiness uses a disposable 250 ms probe rather than leaking that deadline into the operational client, and daemon dispatch runs on Tokio's blocking pool so metadata traversal cannot starve loopback health or unrelated reads. Future work should add a persistent metadata cache or platform-optimized traversal before expanding the allowlist.

## Current Objective

Migrate Fishbowl's knowledge engine to Rust and introduce deterministic hierarchical
retrieval. The active design is
`docs/specs/2026-07-16-rust-hierarchical-retrieval.md`.

## Authoritative Current Status (2026-07-16)

Stages 0 through 8 are implemented and offline-accepted on
`codex/fishbowl-efficiency-rounds`. Rust is the only persistence, migration,
recovery, retrieval, ranking, graph, policy, import/export, redaction, HTTP,
and daemon core. TypeScript is limited to protocol DTOs and MCP/CLI/browser
adaptation; `better-sqlite3` and the old Node daemon/core have been removed.

All Rust workspace tests, the 48/48 TypeScript adapter/CLI tests, production
build, architecture boundary, fixed native release benchmark, and isolated
production-database-copy smoke pass. The latest fixed fixture measured 0.337
ms warm RPC p95, 2.367 ms checkpoint p95, and 0.033 ms daemon Preflight
execution p95. The only remaining action is the explicit human-approved
installed production cutover followed by real installed preflight, query,
checkpoint, and Trace Bench smoke. Do not switch the current-user daemon or
modify production data without that approval.

The executable production and rollback sequence is documented in
`docs/native-production-cutover.md`. The legacy data directory is a proven
strict superset across all non-rebuildable business tables; do not select the
smaller platform-default database merely because the current LaunchAgent uses
it. The current installation may contain both a descriptor daemon and another
LaunchAgent-owned Node process, so cutover must verify database holders rather
than stopping only one PID.

## Rust Migration Status

Stages 0-1 are implemented on `codex/fishbowl-efficiency-rounds`. `fishbowl-core` provides a
project/domain Unicode prefix tree with Han bigram routing and explicit
Guardrail all-of/any-of semantics. `fishbowl-daemon` reads the existing core SQLite
tables in query-only mode, builds one cached tree per project, and invalidates
it using the project event revision.

The first 10,000-Case daemon benchmark exposed a correlated per-node domain
subquery: cold load was 10,010.541ms. Replacing it with one grouped CTE reduced
debug cold load to 1,147.123ms (88.54%). The release result is 177.349ms cold,
6.292µs warm p50, and 7.625µs warm p95. Pure release tree lookup is 1.417µs
p95. These numbers exclude MCP transport and full response construction.

`fishbowl-contracts` now owns strict protocol-v1 DTOs and complete public result
shapes for `queryKnowledge`, `preflight`, and `getCase`. Shared synthetic JSON
fixtures replay canonically in Rust and TypeScript. The Rust protocol keeps a
bounded request-ID cache, rejects changed-input reuse, emits sanitized stable
errors, and gives explicit restart/reinstall guidance for protocol mismatch.
Release replay p95 is 3µs over 1,000 iterations, excluding startup.

The Rust query path is still not wired into the installed daemon. Do not
duplicate retrieval or Guardrail policy in TypeScript while the remaining Rust
stages and installed lifecycle are completed.

Stage 2 now has a query-only `fishbowl-storage` repository that resolves project IDs
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

Stage 3 Rust policy and Preflight are complete. `fishbowl-core` owns promotion,
regression, staleness, Guardrail all/any evaluation, trusted blocking,
explainable ranking, and response compaction. `fishbowl-storage` evaluates every
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
registration/update is now also Rust-owned with canonical path conflicts and
atomic metadata/alias updates. Versioned snapshot export/import is Rust-owned
with deterministic remapping, trust downgrade, redaction, relation/cycle
validation, and local Artifact relocation. Explicit-content Markdown/JSON
preview and apply are also Rust-owned with stale-source detection and candidate
trust. Backup-first schema v1-v7 migration, fault rollback, restore-to-new-path,
and corrupt/newer preservation are complete. An online backup of the installed
database passed Rust quick-check and snapshot/SQL parity (59/288/363/23/8).
Stage 6 implementation is complete; the installed TypeScript daemon remains the
sole writer until Stage 7 performs the tested one-time native daemon cutover.

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

Post-merge installation exposed and fixed npm symlink execution: direct CLI/MCP detection now compares real paths, with a regression test. The current-user macOS LaunchAgent is installed and running; `fishbowl daemon status` is the authoritative way to retrieve its current dynamic Trace Bench URL.

The first real daemon startup also exposed the legacy default-directory migration gap. Startup now migrates a populated `~/.fishbowl/data/knowledge.db` into an empty platform-default store using SQLite backup and a destination backup, but never overwrites populated or explicitly selected stores. The installed database now exposes the existing `yqshunjian-ios-codex` project.

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

`/Users/eric/yqshunjian-ios-codex/.worktrees/s1-pro-compact` is registered in the configured user-local Fishbowl database and resolves to project `fafff939-4e7a-42da-afc7-5782dde8947a`; no duplicate project was created.

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
3. Failed `fishbowl run`: Nonzero/signal outcomes preserve the command result, reuse/create a fingerprinted candidate Problem, and append an unclassified failed Attempt using stable source keys.
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

## Disk cache handoff (2026-07-17)

Schema v9 adds the persistent project-scoped disk measurement cache described
in `docs/decisions/ADR-20260717-persistent-disk-measurement-cache.md`. Candidate
real-tree measurements reduced the prior 6.73-second scan to 0.47 seconds for a
hot start and 0.28 seconds for a hot finish. One changed root completed in 0.29
seconds and retained an exact 25-byte delta. Cache hits intentionally force
review-only cleanup confidence because in-place file rewrites may not alter
directory mtimes. Production schema-v9 migration and installed-state acceptance
are complete: repeated hot start/finish measured 0.55/0.54 seconds with 22 hits,
zero misses, and zero byte delta; `quick_check=ok` preserved 83 Cases and 480
nodes. The rollback branch and quiesced schema-v8 backup are recorded in the
benchmark report.

## Daemon protocol and unified-entry handoff (2026-07-17)

The generic daemon error was not database corruption. The failing checkpoint
sent obsolete string RootCause/Solution fields, and workspace configuration
also selected a separate legacy data directory. Protocol generation 2 and
field-specific CLI validation are implemented with focused RED/GREEN coverage.
Codex user/workspace configuration now contains no `FISHBOWL_DATA_DIR`; normal
traffic targets the platform-default installed daemon. Production acceptance
is complete: hashed backups retain both inputs, the HarmonyOS project and raw
logs were migrated, SQLite quick/foreign-key checks passed, one protocol-v2
LaunchAgent owns the store, and a well-formed checkpoint succeeded. The legacy
directory remains only as `backups/unified-entry-20260717-153746/retired-legacy-data`.

## Codex MCP-only handoff (2026-07-18)

Codex Fishbowl operations now have one supported runtime path: direct calls to
the required user-level `fishbowl` MCP server. Global and project rules forbid
CLI, Node-entry, shell-wrapper, daemon-HTTP, and direct-SQLite fallback. The
stdio command in `~/.codex/config.toml` remains only the MCP Host process
descriptor. The registered iOS repository's project configuration no longer
overrides the user-level service, and its Fishbowl skill records observed shell/Xcode results
afterward through MCP. Restart Codex or open a new task to load the renamed
`fishbowl` namespace; the already-running task may retain the former
`engineering_knowledge_graph` namespace until then.

The Windows follow-up documents a complete PowerShell update sequence and
absolute Node/MCP entry resolution. The Agent prompt now treats MCP discovery
as the only Fishbowl discovery path: a missing namespace is reported for human
configuration or client restart, never followed by PATH, package, filesystem,
CLI, HTTP, or SQLite discovery from the Agent session.

Human operators on macOS and Windows can now use `fishbowl update` after one
manual bootstrap. The updater accepts only a clean official `origin/main` and
fast-forward history, preserves the platform knowledge directory, refreshes
the linked build and daemon, and verifies health. A deployed-revision marker
and ignored `dist` backup make failed same-revision deployments rerunnable and
restore the prior daemon when possible. It refuses local changes, forks, and
other branches before fetch; divergence is rejected after fetch but before
worktree, build, or daemon mutation. macOS waits for LaunchAgent health rather
than starting a competing daemon. Doctor health is an authenticated RPC, and
stop refuses unverified PIDs before waiting for exit. Windows registration
never signals a retained descriptor PID; authenticated stop owns updater
shutdown, and `daemon install` also authenticates, stops, and waits before
replacing a running daemon. macOS gets a bounded 2.5-second readiness window.
A narrow probe-to-signal race remains pending a native authenticated
shutdown RPC. MCP clients still need a full restart afterward; Agents never
invoke the updater.

The human CLI is now self-describing. Bare `fishbowl`, top-level and nested
help flags, and `fishbowl help <topic>` return layered guidance without daemon
startup. Every public leaf command has usage; `--version`/`-V` are supported;
and argument/runtime errors retain JSON `error`/`message` fields while adding
`usage`, actionable or typo-aware `hint`, and the exact `help` command. The
`run --` boundary preserves child help flags. This does not authorize Agents
to use the CLI: normal Agent Fishbowl access remains direct MCP only.

## Protocol reliability handoff (2026-07-18)

Protocol generation 2 now has `getOperationResult` and project-scoped
`getOperationMetrics` operations. The first provides project-scoped durable
confirmation for an ambiguous idempotent write; the second reads the native
daemon's bounded shared metric window instead of an ephemeral MCP-only window.
The MCP metrics input now requires `project`; this intentionally replaces the
pre-release unscoped form so metrics cannot cross project boundaries.
Rust write validation retains actionable detail, while MCP `finalize_work`
cross-field failures include exact paths. Query results are Case-diverse by
default and retain `resultMode: "nodes"` compatibility. Promotion results add
`nextActions`; `close_case` remains the explicit promotion gate and never
creates human confirmation. Stdio requests are capped, parser details are
bounded, and invalid UTF-8 never dispatches. Final blocking review, TypeScript
typecheck, 59/59 Vitest tests, the complete Rust workspace, production build,
formatting, and diff checks passed. The configured acceptance target currently
contains no test files. No SQLite migration is required.
