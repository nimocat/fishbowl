# Handoff

## Current Objective

Complete final verification and integration of the daemon/relevance optimization on `codex/daemon-relevance-speed`. The implementation plan is `docs/superpowers/plans/2026-07-15-daemon-relevance-speed.md`.

## Status

The main optimization slices are implemented and committed: authenticated persistent daemon; thin CLI/MCP clients; retry-safe operation IDs; Case-ranked sub-12-KiB Preflight cards and revision cache; concise `checkpoint_work`; schema-v7 digest-only feedback and reviewed merge proposals; no-admin macOS/Windows startup registration; and daemon-owned live Trace Bench. Release gates pass: typecheck, 175/175 Vitest, 2/2 acceptance, 2/2 Chromium outside the restrictive macOS sandbox, build, diff check, and compiled multi-process daemon/checkpoint/Preflight/web smoke.

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
