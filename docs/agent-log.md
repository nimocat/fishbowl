# Agent Log

## 2026-07-14 CST - Query/Write Efficiency Plan Approved

- Goal: Resolve the end-to-end efficiency problems observed in the `s1-pro-compact` workload while preserving existing EKG contracts and history.
- Evidence: The largest Case returns about 337 KiB although its SQLite read is sub-millisecond; current FTS uses `%LIKE%`; preflight scans all project nodes; CLI cold starts add about 100 ms.
- Decisions: Use schema-v6 indexed Case history, compact default Case reads with explicit full pages, FTS candidate retrieval, indexed reachability, atomic checkpoint writes, and process-local content-safe metrics.
- Documentation: Approved design committed as `4d92625`; implementation plan saved at `docs/superpowers/plans/2026-07-14-query-write-efficiency.md`.
- Blockers: None. Inline execution in the current worktree is approved; no subagents or extra worktrees.
- Next: Execute Task 1 with a failing migration/history regression test.

## 2026-07-13 23:59 Local - First Release Verified

- Goal: Complete and independently verify delivery slices 2 through 6.
- Completed: Closed all final review findings, including Artifact path boundaries; final review returned `Spec: PASS` and `Quality: APPROVED`.
- Changed files: Application, domain, storage, MCP, CLI, logs, HTTP/SSE, browser, import/export, tests, README, ADR, and project memory documented in `docs/implementation-plan.md`.
- Verification: `npm run typecheck`; `npm test` 149/149; `npm run test:acceptance` 1/1; `npm run test:browser` 2/2 in Chromium; `npm run build`; built-bin SQLite quick check and empty project list; `git diff --check`.
- Blockers: None. Changes remain uncommitted on `feat/complete-project` pending integration choice.
- Next: Commit and merge locally, create a PR, or preserve the worktree.

## 2026-07-13 23:55 CST - Final Path-Boundary Findings Complete

- Goal: Fix the final two release findings test-first without committing.
- Completed: Added a canonical service-data boundary derived from file-backed SQLite paths or explicitly injected for in-memory services; canonicalized and validated modern and legacy command-log paths; validated snapshot Artifact rows and linked Artifact-node URIs before mutation; preserved external references without filesystem handling.
- Changed files: `src/domain/policies.ts`, `src/application/knowledge-service.ts`, `src/imports/snapshot.ts`, `tests/application/knowledge-service.test.ts`, `tests/imports/import-service.test.ts`, `CONTEXT.md`, `docs/implementation-plan.md`, `docs/agent-log.md`, and `docs/handoff.md`.
- Decisions: Local references may resolve only inside selected canonical roots/aliases or the service data root. Canonicalization occurs before the boundary decision and persistence. Artifact nodes without an external Artifact row default to local validation; explicitly external rows and linked nodes retain their URI as a reference.
- TDD: Command-path RED failed because `/etc`, sibling-project, and symlink-escape paths were accepted. Snapshot RED failed for the same three row URIs; a second RED proved an unsafe linked Artifact-node URI bypassed row validation. Focused GREEN passed 50/50 across service, import, path-policy, CLI, and MCP tests.
- Verification: The final post-review rerun passed: `npm run typecheck`; `npm test` with 149/149 across 21 files; `npm run test:acceptance` with 1/1; `npm run test:browser` with 2/2 in Chromium; `npm run build`; and `git diff --check`.
- Blockers: None.
- Next: Review and integrate the uncommitted work.

## 2026-07-13 23:43 CST - Six Re-review Findings Complete

- Goal: Fix all six remaining re-review findings test-first without committing.
- Completed: Downgraded imported verified Case/RootCause/Solution/SuccessCase/Guardrail assertions to candidate; added bounded iterative pre-redaction snapshot validation and bounded exports; removed pre-scoring project-node and Guardrail limits; required every RootCause failed Attempt to have `outcome=failed`; carried complete validated raw-log artifact metadata through CLI/MCP and durable Artifacts; and made same-project browser Case selection abortable and token-ordered.
- Changed files: Snapshot import/export, application service/contracts, raw-log storage, command capture, MCP schema, browser application, focused unit/integration/browser tests, context, implementation plan, and handoff.
- Decisions: Portable snapshots cannot confer trust; imported verified assertions are candidates until locally re-established. Snapshot bounds are enforced before recursive transformation. Matching and scoring precede caller limits. Raw-log `byteSize` records accepted session bytes while `retainedByteSize` records bytes surviving retention.
- TDD: The initial focused run produced 10 expected failures across five files; the timestamp-stabilized Guardrail regression then failed independently as expected. Focused GREEN passed 40/40. The MCP metadata contract produced its own expected schema failure before passing. Final focused service/browser tests passed 16/16, MCP passed 7/7, and Playwright passed 2/2.
- Verification: `npm run typecheck` passed; `npm test` passed 146/146 across 21 files; `npm run test:acceptance` passed 1/1; `npm run test:browser` passed 2/2; `npm run build` passed; built-bin integrity returned `quick_check: ok`; built project list returned `[]`; `git diff --check` passed.
- Blockers: None.
- Next: Review and integrate the uncommitted work.

## 2026-07-13 23:31 Local - Final Review Fix Wave Complete

- Goal: Fix every Critical and feasible Important final-review finding without committing.
- Completed: Added stateful argv redaction; Verification environment allowlisting; automatic failed-run Problems/Attempts; human-confirmed verified promotion; relevance-first preflight; pre-spawn cwd ownership; bounded redacted snapshot import; MCP enum/annotation/storage corrections; schema-v5 ownership triggers and private permissions; hardened raw-log retention and command-log artifacts; snapshot-safe HTTP/SSE; stale-safe browser reads and richer bounded details; clean builds; command lifecycle events; and grouped JSON test-report Problem/Attempt imports.
- Changed files: Security, domain, application service/contracts, CLI, storage/schema, imports, MCP, HTTP/SSE, browser assets, tests, README, context, implementation plan, and handoff.
- Decisions: `humanConfirmed=true` is required to assert a verified RootCause and a successful human Verification is required for promotion; MCP close/regression require `operationId`; direct stdio uses `<EKG_DATA_DIR>/knowledge.db`; command-log Artifacts remain local and are omitted from portable snapshots.
- TDD: Findings 1-5 produced 6 expected focused failures before implementation; findings 6-10 produced 6 expected focused failures; findings 11-14 produced 6 expected focused failures; grouped import produced 1 expected failure. All focused suites passed after minimal fixes. The first full gate exposed two stale acceptance expectations and command-log export leakage; browser gating exposed nondeterministic same-timestamp project ordering. Each received a focused fix before the complete gate rerun.
- Verification: `npm run typecheck` passed; `npm test` passed 139/139 across 21 files; `npm run test:acceptance` passed 1/1; `npm run test:browser` passed 1/1; `npm run build` passed with `dist` cleaned first; built-bin integrity returned `quick_check: ok`; built project list returned `[]`.
- Blockers: None.
- Next: Review and integrate the uncommitted work.

## 2026-07-13 22:45 Local - Browser Runtime Verified

- Goal: Verify the read-only Trace Bench in a real browser runtime.
- Completed: Added a Chromium Playwright test for project rendering, semantic graph access, keyboard focus, serious/critical axe violations, live SSE updates without refresh, and project-switching isolation.
- Changed files: `playwright.config.ts`, `tests/browser-e2e/trace-bench.spec.ts`, `package.json`, `package-lock.json`, `.gitignore`, `README.md`.
- Decisions: Browser tests are a separate release command so Vitest remains the fast unit/integration gate.
- Verification: `npm run test:browser` passed 1/1 in headless Chromium.
- Blockers: None.
- Next: Final full-suite verification and whole-branch review.

## 2026-07-13 20:40 Local - Full Release Started

- Goal: Complete delivery slices 2-6 from the approved design.
- Completed: Reviewed slice 1, architecture, test risks, MCP SDK status, and browser information architecture.
- Changed files: `AGENTS.md`, `CONTEXT.md`, `docs/implementation-plan.md`, `docs/decisions/ADR-20260713-modular-local-service.md`.
- Decisions: Modular local service; SQLite materialized state is authoritative; v1 MCP SDK; native HTTP/SSE and static browser.
- Verification: Slice 1 baseline previously passed 32 tests, typecheck, and build.
- Blockers: None.
- Next: Implement platform/domain policies and stabilize `KnowledgeService` contracts.

## 2026-07-13 20:51 Local - Task 1 Platform and Domain Policies Complete

- Scope: Implemented only Task 1 from `docs/implementation-plan.md`; no service, MCP, CLI, HTTP, or browser code was added.
- Changed: Added ordered SQLite schema migrations and version checks, a 5-second busy timeout, command/artifact/import/source-key/search storage, typed node-data validation, promotion/regression/guardrail policies, fingerprint normalization, secret redaction, byte-bounded excerpts, and path/payload boundaries.
- TDD: The first focused red run had 5 failing files because schema versioning and policy modules were absent. A second focused red run had 8 expected failures for optional-field validation, empty applicability boundaries, command/JSON redaction, and symlink escapes. A final schema red test proved import proposals lacked direct project scope. All three sets passed after minimal implementation.
- Verification: Focused Task 1 tests passed 41/41; full `npm test` passed 72/72; `npm run typecheck` and `npm run build` exited successfully.
- Decisions: Schema version 2 is applied through ordered idempotent migrations; databases with newer versions are rejected. Guardrail matching requires every populated criterion and blocks only for `verified` plus `block`.
- Remaining: Search projection population and all command/import consumers belong to later plan tasks.
- Blockers: None.

## 2026-07-13 21:08 CST - Task 2 Knowledge Service Complete

- Goal: Implement only Task 2 as the transport-neutral application boundary while preserving the slice-1 APIs.
- Completed: Added exact public service contracts; project register/list/resolve/update; bounded project-scoped query, Case detail, activity, and preflight reads; all requested capture operations; mixed-evidence promotion and SuccessCase construction; close and immutable regression handling; stable service errors; operation/source idempotency; and two-project ownership checks.
- Changed files: `src/application/contracts.ts`, `src/application/knowledge-service.ts`, `src/index.ts`, `src/projects/project-registry.ts`, `src/storage/schema.ts`, `tests/application/knowledge-service.test.ts`, `docs/implementation-plan.md`, `docs/agent-log.md`, `docs/handoff.md`.
- Decisions: Schema version 3 adds project-scoped operation results. Compound service writes use one outer SQLite transaction around materialized rows, projections, graph relations, and events. Promotion uses the successful Attempt's decisive difference and creates one reusable SuccessCase. Preflight preserves Attempt order and only verified blocking Guardrails block.
- TDD: Initial focused run failed 4/4 because `KnowledgeService` did not exist. The first implementation reached 3/4 green, then exposed chronological preflight ordering, query expectation, and recursive secret-redaction gaps. Separate red runs proved Solution text incorrectly satisfied the successful-Attempt requirement, regressed knowledge could be accidentally re-promoted, cross-type source keys were accepted, and project errors escaped the stable service contract; each passed after its focused fix.
- Verification: Focused service tests passed 5/5; focused service plus slice-1 storage tests passed 18/18; full `npm test` passed 77/77; `npm run typecheck`, `npm run build`, and `git diff --check` succeeded.
- Blockers: None.
- Next: Task 3 MCP Adapter can implement tools directly against `KnowledgeServiceContract`.

## 2026-07-13 21:28 CST - Task 6 Import and Portability Complete

- Goal: Implement Task 6 before transport adapters, preserving existing APIs and project isolation.
- Completed: Added explicit file and Git-range acquisition, bounded Markdown/plain-text and JSON test-report parsing, persisted candidate previews with parser/source digests and expiry, stale-safe selected apply, and versioned redacted project snapshot export/import.
- Changed files: `src/imports/import-service.ts`, `src/imports/parsers.ts`, `src/imports/snapshot.ts`, `src/application/contracts.ts`, `src/application/knowledge-service.ts`, `src/storage/schema.ts`, `src/index.ts`, `tests/imports/import-service.test.ts`, `CONTEXT.md`, `docs/implementation-plan.md`, `docs/agent-log.md`, `docs/handoff.md`.
- Decisions: Schema version 4 stores parser version, immutable source manifest, and preview expiry. File sources use realpath boundary checks and 1 MiB limits. Git accepts only `base..head`, resolves both refs to commit IDs, reads commits with argv plus `shell: false`, and rechecks immutable commit content at apply. All parser output remains `candidate`.
- TDD: Initial RED was 7/7 failures for the absent facade/modules. Subsequent RED runs exposed `/private/var` root alias leakage, aggregate Git reads, deleted-source staleness, operation-ID selection conflicts, malformed archive entry errors, source-project remapping, and snake_case raw-log metadata; each was made green with focused changes.
- Verification: Focused import tests pass 8/8. Final full test/typecheck/build/diff verification is recorded in the handoff.
- Blockers: None.
- Next: Implement Tasks 3-5 against the four new `KnowledgeServiceContract` methods without bypassing the application boundary.

## 2026-07-13 21:44 CST - Task 3 MCP Adapter Complete

- Goal: Expose every design-section-9 operation through supported MCP v1 and a quiet stdio runner without moving business logic into the transport.
- Completed: Added `createMcpServer(service)` with all 22 exact tools, explicit project-reference schemas, bounded strings/arrays, output schemas, concise text plus structured results, operation annotations, and stable actionable service/domain error translation. Added `runStdioServer()` with injectable streams/database path and no startup output on protocol stdout.
- Changed files: `src/mcp/server.ts`, `src/mcp/stdio.ts`, `tests/mcp/server.test.ts`, `src/index.ts`, `package.json`, `package-lock.json`, `CONTEXT.md`, `docs/implementation-plan.md`, `docs/agent-log.md`, `docs/handoff.md`.
- Decisions: Pinned `@modelcontextprotocol/sdk` 1.29.0 and Zod 3.25.76. MCP success results use `{ ok: true, result }` structured content plus a short text summary. Validation remains SDK-native; service failures return `isError` with stable codes and recovery actions. Filesystem-reading registration/update/preview tools use `openWorldHint: true`; update metadata is marked destructive while additive graph writes are not.
- TDD: Initial focused RED failed because `src/mcp/server.ts` was absent. The expanded protocol suite remained RED until real initialize/list/call, exact discovery, validation, full Problem-to-regression capture, two-project query isolation, and stable errors worked. A separate stdio RED failed because `src/mcp/stdio.ts` was absent. Later RED runs proved facade project errors were incorrectly mapped to `INTERNAL_ERROR`, unknown exceptions leaked raw messages, and nested metadata was not bounded before service invocation; each passed after a focused boundary fix.
- Verification: Focused MCP tests passed 7/7. Full `npm test` passed 92/92. `npm run typecheck`, `npm run build`, `npm ls @modelcontextprotocol/sdk zod`, and `git diff --check` succeeded.
- Blockers: None.
- Next: Implement Task 4 CLI/command capture, then Task 5 HTTP/browser and Task 7 acceptance hardening.

## 2026-07-13 22:06 CST - Task 5 HTTP, SSE, and Browser Complete

- Goal: Deliver the loopback-only read API, durable project-scoped SSE cursor, and approved read-only Trace Bench browser without bypassing `KnowledgeServiceContract`.
- Completed: Added native Node HTTP startup fixed to `127.0.0.1`; Host and same-origin checks; health, project, graph, search, activity, Case, and event routes; snapshot sequence annotations; URL/JSON/Case/node/edge bounds; cross-connection SSE polling, heartbeat, and gap recovery; static asset allowlisting; and the responsive semantic Trace Bench interface with project scope, filters, Case results, native graph buttons, SVG edges, timeline, evidence, activity, reconnect, focus, reduced-motion, empty/error/regression states, and no mutation controls.
- Changed files: `src/http/server.ts`, `src/http/sse.ts`, `src/web/index.html`, `src/web/styles.css`, `src/web/app.js`, `scripts/copy-static-assets.mjs`, `tests/http/server.test.ts`, `tests/browser/app.test.ts`, `src/index.ts`, `package.json`, `CONTEXT.md`, `docs/implementation-plan.md`, `docs/agent-log.md`, `docs/handoff.md`.
- Decisions: API adapters consume only service reads. `Last-Event-ID` takes precedence over `after`. A truncated event read emits one `snapshot_required` cursor. Graph snapshots cap at 100 Cases, 100 nodes and 200 valid edges per Case, and 1 MiB encoded JSON. Static requests map only three named assets, which build copies to `dist/web`.
- TDD: HTTP RED failed 5/5 because startup was absent, then passed 5/5. SSE RED failed 3/3 with 404, then the combined suite passed 8/8. Static RED failed four checks for absent assets/routing, then passed 12/12. The copy-script RED failed because the script was absent, then passed 4/4. A dense graph RED returned 106 nodes over the intended limit, then passed 10/10 after per-Case bounds.
- Verification: Focused browser tests passed 4/4 and focused HTTP tests passed 10/10. Final full test, typecheck, build, syntax, built-asset, and diff checks are recorded in the handoff.
- Blockers: None.
- Next: Implement Task 4 CLI/command capture and Task 7 acceptance hardening.

## 2026-07-13 22:27 CST - Task 4 CLI and Command Capture Complete

- Goal: Complete the remaining Task 4 CLI and process-capture work while preserving the prior agent's `src/logs/raw-log-store.ts` implementation.
- Completed: Added the executable `ekg` adapter; explicit parser and JSON-oriented payload flags; serve and MCP lifecycle commands; project, query, preflight, Case, import/export, activity, and integrity dispatch; exact-argv command execution; verified-block exit 78; inherited stdin and unchanged cwd; separate byte teeing; POSIX signal forwarding; exact zero/nonzero and 126/127 exit handling; bounded redacted combined excerpts; raw-log digest/path metadata; and fail-open log/knowledge recording.
- Changed files: `src/cli/arguments.ts`, `src/cli/main.ts`, `src/cli/run-command.ts`, `tests/cli/*`, `scripts/prepare-bin.mjs`, `package.json`, `package-lock.json`, `src/index.ts`, `CONTEXT.md`, `docs/implementation-plan.md`, `docs/agent-log.md`, `docs/handoff.md`. `src/logs/raw-log-store.ts` was not modified.
- Decisions: CLI data defaults to `EKG_DATA_DIR` or `~/.engineering-knowledge-graph/data`, never cwd; `--data-dir` wins. Complex values are explicit JSON. Raw logs remain unredacted local files, while SQLite receives only a redacted 8 KiB excerpt and JSON path/digest metadata. Incomplete raw-log writes produce warnings and null metadata.
- TDD: Parser/dispatch RED failed because both CLI modules were absent, then passed 5/5. Process RED failed because `run-command.ts` was absent, then passed 5/5. A focused regression RED proved incomplete raw-log metadata was recorded after a write error, then passed 6/6. Bin RED had two failures for missing package/shebang/export wiring. A final scope RED proved query JSON could override `--project`; it passed after an allowlist plus explicit-project-last dispatch.
- Verification: Focused CLI/raw-log tests passed 17/17. Full `npm test` passed 123/123. `npm run typecheck`, `npm run build`, direct executable `dist/cli/main.js` integrity/list smoke, and `git diff --check` passed.
- Blockers: None.
- Next: Complete Task 7 operating documentation and executable acceptance hardening.

## 2026-07-13 22:35 CST - Task 7 Automated Acceptance In Progress

- Scope: Implemented only automated release acceptance and test discovery isolation; no operating documentation was added and Task 7 remains in progress.
- Changed: Added `vitest.config.ts` with root-local `tests/**/*.test.ts` discovery and explicit `.worktrees`, `dist`, and `node_modules` exclusions; added `npm run test:acceptance`; and added `tests/acceptance/first-release.test.ts`.
- Acceptance: The public `KnowledgeService` and real HTTP/SSE journey registers two projects, proves stable fingerprinting and project isolation, preserves ordered failures, promotes only after automated plus required human evidence, verifies complete SuccessCase history, blocks on a verified Guardrail, receives the later regression event once from an SSE cursor, preserves history through regression, and round-trips a redacted archive without raw-log metadata or the secret sentinel.
- TDD: The first acceptance command failed because `test:acceptance` was absent. After adding the script/config, the first test execution exposed an incorrect assumption about the SSE envelope; the corrected contract assertion passed 1/1.
- Verification: `npm run test:acceptance` passed 1/1; full `npm test` passed 124/124 across 21 files; `npm run typecheck`, `npm run build`, and `git diff --check` succeeded.
- Remaining: Add the Task 7 operating documentation (`README.md` and MCP client configuration) before marking Task 7 complete.
- Blockers: None.

## 2026-07-13 22:43 CST - Task 7 And First Local Release Complete

- Goal: Finish database integrity/recovery hardening, security regression coverage, operating documentation, MCP client setup, and release verification without committing.
- Completed: Added read-only preflight for existing SQLite files, stable corrupt/newer-schema recovery errors that preserve original bytes, `ekg integrity` `quick_check` reporting and actionable backup/recovery/export guidance, and one recursive sentinel assertion over events, search projection/service results, HTTP graph/search/activity/Case responses, and export. Added `README.md` and `docs/mcp-client-configuration.md`; marked Task 7 and the first local release complete.
- Changed files: `src/storage/database.ts`, `src/cli/main.ts`, `tests/storage/database.test.ts`, `tests/cli/main.test.ts`, `tests/acceptance/first-release.test.ts`, `README.md`, `docs/mcp-client-configuration.md`, `docs/superpowers/specs/2026-07-13-engineering-knowledge-graph-design.md`, `docs/implementation-plan.md`, `CONTEXT.md`, `docs/agent-log.md`, `docs/handoff.md`.
- Decisions: Existing databases must pass read-only `quick_check` and schema compatibility before any writable initialization. Recovery always works from backups/copies or a separate data directory. README is the first-release command reference because built top-level and subcommand `--help` are not implemented.
- TDD: Focused RED produced three expected failures for missing stable recovery errors and missing `quick_check` identification. The secret sentinel assertion was already green only after traversing all required boundaries. Focused GREEN passed 8/8 across storage, CLI, and acceptance.
- Verification: `npm run typecheck` passed; `npm test` passed 126/126 across 21 files; `npm run test:acceptance` passed 1/1; `npm run build` passed; built-bin integrity returned `ok: true` with `quick_check`; built project list returned `[]`; and the documented client workflow completed through capture, manual Case verification/close, query, preflight, import preview/apply, export, and graph import. Final diff checks are recorded in the handoff.
- Blockers: None.
- Next: Add CLI help if desired, or integrate the branch without changing the local-only first-release boundary.
## 2026-07-14 09:48 CST - Query/Write Compatibility Refactor Implemented

- Goal: Resolve the observed `s1-pro-compact` EKG query/write efficiency risks without breaking existing callers or moving away from local SQLite.
- Completed: Added transactional schema-v6 migration with explicit Case event ownership and adjacency indexes; compact/summary/full Case projections and indexed history cursors; project-scoped FTS5 query/preflight candidates; recursive Case-local cycle detection; atomic idempotent checkpoints; bounded content-free MCP operation metrics; and explicit imported-event Case ownership.
- TDD: Every behavior slice was introduced with a focused failing test. Added deterministic response-size and SQLite query-plan regression coverage.
- Review fixes: Added event Case/project ownership enforcement, explicit Case IDs for all Case-scoped events, explicit project scope in count/reachability SQL, bounded preflight fallback with direct fingerprint candidates, service-level checkpoint kind validation, minimized batch error details, and safe-integer metric clamping.
- Final verification: `npm run typecheck` passed; `npm test` passed 157/157 across 24 files; `npm run build` and `git diff --check` passed; `npm run test:browser` passed 2/2 outside the macOS sandbox after the sandbox-only Chromium launch denial. The runtime alias registered and resolved to project `fafff939-4e7a-42da-afc7-5782dde8947a`.
- Privacy and ownership: Metrics are in-memory scalar aggregates only. No request bodies, response bodies, raw logs, environment values, or excerpts were added to SQLite. All new database access remains explicitly project/Case scoped.
- Blockers: None. Final implementation commit pending.

## 2026-07-15 20:20 CST - Persistent Daemon, Relevance, and Checkpoint Optimization Implemented

- Goal: Convert EKG from per-command SQLite startup into a reusable macOS/Windows engineering-memory service, while sharply reducing Preflight noise and checkpoint cost.
- Completed: Added authenticated versioned loopback RPC with bounded idempotent replay; CLI/MCP daemon proxying; automatic startup; macOS LaunchAgent and Windows HKCU Run installation; daemon-owned live Trace Bench; Case-level explainable Preflight cards capped at five and 12 KiB; project-revision LRU caching; concise transactional `checkpoint_work`; candidate-age penalties; digest-only relevance feedback; and explicit reviewed Case merge/supersession.
- TDD: Each slice began with missing-module or missing-method RED tests. Focused GREEN covers daemon auth/protocol/client retry, remote CLI/MCP sharing, ranking/compaction/cache performance, checkpoint replay/capture policy, platform registration commands, schema-v7 migration, relevance feedback, and non-automatic merge proposals.
- Privacy: RPC request/response bodies and query text are not persisted. Feedback stores only a caller-computed SHA-256 digest and Boolean. Tokens/descriptors are owner-only. Raw-log policy is unchanged.
- Commits: `6c67ae4`, `c4914ac`, `abc679f`, `427814a`, `d1953c6`, `00315c1`.
- Verification: `npm run typecheck` passed; `npm test` passed 175/175 across 33 files; acceptance passed 2/2; Chromium passed 2/2 outside the macOS sandbox after the expected sandbox-only Mach-port denial; build and diff checks passed. A compiled foreground daemon reported its live `webUrl`, accepted remote project registration and concise checkpoint, and returned the expected compact Preflight card through a separate CLI process.
- Blockers: None.

## 2026-07-15 20:33 CST - npm Symlink CLI Entry Fixed And Daemon Installed

- Goal: Resolve `zsh: command not found: ekg` and complete the real macOS daemon startup.
- Root cause: npm linked `ekg` under the Hermes prefix, which was outside the active PATH. After exposing it through `~/.local/bin`, Node resolved the symlink to the real module while `process.argv[1]` retained the symlink path; the old literal-URL direct-execution check therefore treated the executable as an import and exited silently.
- Fix: Added a realpath-aware direct-execution helper shared by CLI and direct MCP startup, plus an npm-style symlink regression test. Linked the existing npm binary into the already-PATH-scoped `~/.local/bin`.
- Verification: Focused regression passed 3/3; typecheck and build passed; the actual `ekg daemon install` registered `io.ekg.daemon`; `launchctl` reports it running; `ekg daemon status` reports PID 74600 and live Trace Bench URL `http://127.0.0.1:58898`.
- Privacy/data: Existing EKG data was preserved; the install modified only the current-user LaunchAgent and command symlink.

## 2026-07-15 20:40 CST - Legacy macOS Database Migrated

- Symptom: Trace Bench loaded normally but the project selector was empty.
- Root cause evidence: daemon CLI and `/api/v1/projects` both returned `[]`; the new macOS default database under `~/Library/Application Support/EKG` was 4 KiB and empty, while the legacy `~/.engineering-knowledge-graph/data/knowledge.db` was about 2.9 MB and contained `yqshunjian-ios-codex`. The default-directory migration had been omitted.
- Fix: Added startup migration that runs only for the platform default destination, only when the legacy database contains projects, and only when the destination has none. SQLite backup creates a consistent temporary database; an existing empty destination is renamed to a timestamped backup before atomic replacement. Populated destinations and explicit custom data directories are never overwritten.
- Verification: Migration tests pass for both empty and populated destinations. The real LaunchAgent restart migrated the project and preserved `/Users/eric/Library/Application Support/EKG/knowledge.db.pre-legacy-migration-1784119186695.bak`. CLI and the new Trace Bench API both return `yqshunjian-ios-codex`.

## 2026-07-15 22:55 CST - Precise Finalized Delivery Capture Implemented

- Goal: Reduce MCP write friction and preserve the decisive successful route, failed routes, root cause, verification, commit, and merge facts in one reusable operation.
- Completed: Added exact collection schemas and `finalize_work` across application, daemon, and MCP. The operation validates the complete envelope before mutation, records one project-scoped graph transaction, stores bounded external Git-fact Artifacts without reading or executing Git, and replays by stable `operationId`.
- Decisions: Case reuse requires explicit `caseId` or exact normalized fingerprint; fuzzy text never selects a Case. Device verification maps to human-kind evidence but does not auto-confirm it. RootCause and Solution remain candidates under existing mixed-verification promotion policy.
- TDD: Added pure conditional validation, graph/service rollback and idempotency, MCP discovery/path validation, authenticated daemon dispatch, and two-client daemon-backed MCP acceptance coverage.
- Verification: Final release-gate results are recorded in `docs/handoff.md`.
