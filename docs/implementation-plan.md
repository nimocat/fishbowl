# Complete First Release Implementation Plan

## Active Follow-up: Task Disk Growth Ledger

**Status:** implemented, release-verified, and installed on schema v8 (2026-07-17)

Schema v8 adds idempotent task start/finish observations, conservative overlap attribution, bounded cleanup history, and metadata-only scanning of known regenerable project roots. Rust owns discovery, byte accounting, project isolation, persistence, and cleanup policy; TypeScript exposes only CLI/MCP DTOs. The feature never follows symlinks, reads contents, records absolute project paths, or deletes artifacts. Candidate release scanning reached the 250,000-entry safety bound in 3.5 seconds; the installed YQSK finish scan returned in 6.73 seconds and marked every truncated result for review. Reducing this cold-scan cost without weakening attribution remains the measured follow-up.

## Active Migration: Rust Hierarchical Retrieval Core

**Status:** Stages 0-8 offline complete; installed production cutover awaits
explicit user approval (2026-07-16)

The accepted direction is documented in
`docs/specs/2026-07-16-rust-hierarchical-retrieval.md`. Durable storage,
retrieval, ranking, Guardrail policy, graph traversal, transactions, redaction
enforcement, and metrics will migrate to Rust. TypeScript remains a temporary
protocol and presentation layer.

Completed in the first slice:

- dependency-free Rust Unicode prefix tree and bilingual query routing;
- explicit Guardrail all-of/any-of semantics in Rust;
- read-only Rust SQLite adapter with event-revision cache invalidation;
- 10,000-Case cold/warm performance gates;
- removal of an O(n²) correlated domain lookup from the Rust loading path.

Stage 1 adds an independent `fishbowl-contracts` crate, strict versioned DTOs for
`queryKnowledge`, `preflight`, and `getCase`, shared redacted JSON fixtures, a
serialization-only TypeScript adapter, stable sanitized errors, and bounded
request-ID replay. Release replay p95 is 3µs excluding process startup. No
production route changed.

Next slices: full Rust `queryKnowledge` result construction and shadow parity,
then read cutover, deterministic hierarchy/community construction, bounded
graph diffusion, and transactional write migration. The TypeScript application
and storage core cannot be removed until parity, migration, recovery, and
release gates pass.

Stage 2 core and shadow validation are now complete: `fishbowl-storage` constructs
complete project-scoped schema-v7 query results, 1,000 persistent-process
queries match TypeScript with zero mismatches, bilingual Recall@5 is 100%, and
the 10,000-Case complete-response p95 is 0.053ms. Installed cutover is held for
Stage 7 native binary packaging/lifecycle work; no developer-path or environment
variable dependency will be introduced as a shortcut.

Stage 3 is complete in Rust. Promotion/regression policy, candidate staleness,
all-of/explicit-any-of Guardrails, verified-block trust, explainable relevance
weights, compact Case cards, 12KiB response bounding, and revisioned content-free
cache metrics now live in `fishbowl-core`/`fishbowl-storage`. A 1,000-request Preflight
shadow run has zero mismatches and p95 0.113ms; blocking recall is 100% with no
false positives in the Guardrail golden set.

Retrieval P0 is implemented and offline/production-copy accepted on 2026-07-17.
The production Rust query now composes exact evidence, deterministic Unicode
candidate routing, true k-shell hierarchy, and bounded candidate-subgraph PPR.
The 120-query real engineering golden set reaches Recall@5 96.7% versus 32.5%
for strict exact retrieval. Release 10k exact/hybrid cold queries measure
0.561ms/110.254ms and hybrid warm p95 is 1.983ms. The active schema-v7 database
copy passed read-only integrity and query shadow without count changes. Details
are in `docs/reports/2026-07-17-retrieval-p0-acceptance.md`. Installed cutover
remains an explicit human gate.

The executable phase-by-phase migration and TDD plan is
`docs/plans/2026-07-16-rust-core-migration-tdd.md`. It defines shared
cross-language fixtures, RED/GREEN/shadow/cutover rules, read-only shadowing,
single-writer migration, per-stage performance and retrieval gates, and
rollback conditions.

## Active Follow-up: Query and Write Efficiency

**Status:** Daemon/relevance optimization complete and release-verified (2026-07-15)

The approved daemon/relevance plan in `docs/superpowers/plans/2026-07-15-daemon-relevance-speed.md` is implemented across its primary production slices: authenticated persistent RPC, thin CLI/MCP proxying, Case-level bounded Preflight cards and revision cache, concise idempotent work checkpoints, candidate staleness penalties, digest-only relevance feedback, reviewed Case merge proposals, no-admin macOS/Windows registration, auto-start, and daemon-owned live Trace Bench. Typecheck, 175 Vitest tests, two acceptance tests, two Chromium tests, build, diff checks, and a compiled remote-daemon/checkpoint/Preflight/web-URL smoke pass.

**Previous status:** Complete and release-verified (2026-07-14)

The seven compatibility-focused TDD tasks are complete: schema-v6 indexed Case history, compact/paged Case projections, FTS-backed candidate retrieval, indexed graph reachability, atomic checkpoint writes, content-safe operation metrics, and adapter/import compatibility. The deterministic performance suite, full Vitest suite, build, browser suite, two-axis review, and runtime worktree-alias verification pass. The executable plan is `docs/superpowers/plans/2026-07-14-query-write-efficiency.md`.

**Status:** Complete and release-verified (2026-07-13)

**Goal:** Complete delivery slices 2-6 from the approved design so a developer can register a project, capture or import command evidence, query it through MCP/CLI, inspect it live in a browser, and export/import a redacted graph.

## Global Constraints

- Bind HTTP only to `127.0.0.1`; deny cross-origin browser requests.
- Require explicit project scope for every graph operation.
- Execute commands as argv with `shell: false` and preserve child exit results.
- Persist only bounded redacted excerpts; raw logs remain separate and rotate.
- Only a verified Guardrail with `enforcement=block` may stop execution.
- Import preview must not mutate graph state; apply must be explicit and transactional.
- Browser remains read-only and has a semantic list alternative to its graph.
- Keep materialized graph mutations and append-only events in one SQLite transaction.

## Tasks

### 1. Platform and Domain Policies

**Status:** Complete (2026-07-13)

**Files:** `src/storage/schema.ts`, `src/storage/database.ts`, `src/domain/node-data.ts`, `src/domain/policies.ts`, `src/domain/fingerprint.ts`, `src/security/redaction.ts`, `tests/domain/*.test.ts`

**Produces:** schema versioning; command runs, artifacts, import previews, source keys, searchable node projections; typed node payload validation; promotion, regression, fingerprint, guardrail, redaction, path, and payload policies.

**TDD gate:** normalization removes paths/timestamps/UUIDs/line numbers; mixed verification reports exact missing requirements; only verified blocking guardrails block; redaction removes token/password/auth formats and enforces excerpt bytes.

### 2. Knowledge Service

**Status:** Complete (2026-07-13)

**Files:** `src/application/knowledge-service.ts`, `src/application/contracts.ts`, `src/projects/project-registry.ts`, `src/storage/schema.ts`, `tests/application/knowledge-service.test.ts`

**Produces:** project update; project-scoped query and activity; record Problem/Attempt/RootCause/Solution/Verification/Artifact/Guardrail/command result; close Case; mark regression; preflight; stable result/error contracts.

**TDD gate:** complete failed-attempt-to-verified-success path, mixed-verification gate, immutable regression history, duplicate operation idempotency, and two-project isolation.

### 3. MCP Adapter

**Status:** Complete (2026-07-13)

**Files:** `src/mcp/server.ts`, `src/mcp/stdio.ts`, `tests/mcp/server.test.ts`, `src/index.ts`, `package.json`, `package-lock.json`

**Produces:** all project, query, preflight, capture, import, and export tool names from design section 9 over stdio, with Zod inputs, bounded structured results, annotations, and actionable errors.

**TDD gate:** real SDK client initializes, discovers tools, records and queries an isolated Case, and receives validation errors without server termination.

### 4. CLI, Command Capture, and Raw Logs

**Status:** Complete (2026-07-13)

**Files:** `src/cli/main.ts`, `src/cli/arguments.ts`, `src/cli/run-command.ts`, `src/logs/raw-log-store.ts`, `tests/cli/*.test.ts`, `tests/logs/*.test.ts`, `package.json`

**Produces:** `fishbowl serve`, project/query/preflight/run/case/import/export commands; raw-log SHA-256, mode `0600`, age and size retention; child argv/output/exit preservation; exit `78` for verified guardrail blocks.

**TDD gate:** helper subprocess proves exact argv, stdout/stderr, zero/nonzero exits, fail-open recording, and block-before-spawn behavior.

### 5. HTTP, SSE, and Browser

**Status:** Complete (2026-07-13)

**Files:** `src/http/server.ts`, `src/http/sse.ts`, `src/web/index.html`, `src/web/styles.css`, `src/web/app.js`, `scripts/copy-static-assets.mjs`, `tests/http/server.test.ts`, `tests/browser/app.test.ts`, `package.json`, `src/index.ts`

**Produces:** loopback read API, project-scoped graph snapshots, search, Case detail, sequence-cursor SSE, static Trace Bench browser with project selection, filters, causal graph/list, attempt timeline, evidence inspector, responsive states, keyboard focus, and reduced motion.

**TDD gate:** origin rejection, project isolation, SSE reconnect without duplication, semantic graph list, mobile layout hooks, and live Case refresh.

### 6. Import Preview/Apply and Portability

**Status:** Complete (2026-07-13)

**Files:** `src/imports/import-service.ts`, `src/imports/parsers.ts`, `src/imports/snapshot.ts`, `tests/imports/import-service.test.ts`

**Produces:** explicit Markdown/plain-text and JSON test-report previews; source digest/staleness checks; selected atomic apply; versioned redacted JSON export; explicit-project import with deterministic ID remapping.

**TDD gate:** preview leaves graph/event counts unchanged, stale apply rejects without mutation, selected proposals apply once, malformed archives reject before mutation, and export/import round-trip preserves graph integrity without raw logs.

### 7. Hardening, Documentation, and Acceptance

**Status:** Complete (2026-07-13)

**Files:** `vitest.config.ts`, `README.md`, `docs/mcp-client-configuration.md`, `tests/acceptance/first-release.test.ts`, `docs/agent-log.md`, `docs/handoff.md`

**Produces:** bounded defaults, busy timeout, integrity/recovery command, `.worktrees` exclusion, operating documentation, MCP configuration, and executable first-release acceptance journey.

**Release gate:** `npm run typecheck && npm test && npm run build`; acceptance registers two projects, preserves failed Attempts, promotes with mixed evidence, returns preflight guidance, proves isolation, marks regression without history loss, and round-trips a redacted export.

**Completed:** Added root-local Vitest discovery with `.worktrees`, `dist`, and `node_modules` exclusions; executable public-service plus HTTP/SSE acceptance; read-only preflight of existing SQLite databases; stable non-destructive corrupt/newer-schema recovery guidance; `quick_check` integrity output; recursive secret-sentinel coverage across events, search, HTTP, and export; complete operating documentation; and Claude, Codex, and OpenCode MCP setup guidance.

## Risks

- MCP SDK v2 is beta; pin supported `@modelcontextprotocol/sdk` v1.
- CLI signal behavior differs by platform; POSIX signal tests are conditional.
- Static SVG layout must stay Case-focused and bounded.
- Generic node JSON must never bypass application validation.
- Redaction must occur before events, search data, exports, and browser responses.
- The first-release CLI has no built-in `--help`; keep README examples synchronized with parser tests until help is added.

## Codex MCP-only Fishbowl access

**Status:** Complete (2026-07-18)

**Scope:** Make direct Fishbowl MCP tool calls the only agent-session path for Codex while retaining CLI and stdio process commands as human installation, diagnostics, and recovery boundaries.

**Implementation:** Added a documentation policy regression test; rewrote the Agent session prompt and Codex MCP configuration guidance; made the user-level server required; documented the no-CLI-fallback decision in repository rules, public READMEs, context, and ADR. The installed Codex policy uses one user-level `fishbowl` server. A registered iOS repository's project-local MCP override was retired, and its Agent rules, Fishbowl skill, and workflow now prohibit CLI, shell-wrapper, daemon-HTTP, and direct-SQLite fallback.

**TDD gate:** `tests/docs/codex-mcp-policy.test.ts` failed against the CLI bootstrap and optional MCP configuration, then passed after MCP-only guidance was installed.

**Windows follow-up (2026-07-18):** Added a reproducible current-user PowerShell update flow and native Windows path examples. Tightened the session prompt so missing MCP tools never trigger CLI discovery (`where`, `which`, `Get-Command`, package scripts, or filesystem search); users configure or restart the MCP Host outside the Agent session.

## Safe CLI self-update

**Status:** Complete; final gates passed (2026-07-18)

**Scope:** Give human operators one safe source-checkout update command without weakening the Agent MCP-only boundary or allowing destructive Git behavior.

**Implementation:** Added option-free `fishbowl update` orchestration for macOS and Windows. It validates a clean official `origin/main`, fetches and permits only fast-forward history, performs a no-op only when source and deployed revisions are current, and installs dependencies before daemon downtime. It backs up `dist` before quiescing the daemon, then builds/links, reinstalls and verifies the daemon, and restores the prior deployment on failure. macOS allows a bounded 2.5-second LaunchAgent readiness window without the generic auto-spawn path. Windows registration never signals a stale descriptor PID; `daemon install` replaces a running daemon only after authenticated stop and confirmed exit. Local changes, forks, and other branches fail before fetch; divergence fails after fetch but before worktree, build, or daemon mutation.

**TDD gate:** Parser and updater suites failed before implementation. Focused tests cover the exact Windows command sequence, source-plus-deployment no-op, dirty/untrusted/non-main/diverged refusal, backup-before-downtime, failed-build rollback and same-revision repair, recovery after registration-removal failure, macOS LaunchAgent polling without auto-spawn, stale-descriptor registration safety, bounded daemon-stop exit semantics, and top-level CLI dispatch.

**Verification:** `npm run typecheck`, all 75 Vitest tests, `npm run build`, `cargo test --workspace`, `cargo fmt --check`, and `git diff --check` passed.

## Self-describing CLI guidance

**Status:** Complete; final gates passed and review findings addressed (2026-07-18)

**Scope:** Make bare invocation, command discovery, argument recovery, diagnostics, and version discovery useful to human operators without weakening machine-readable errors or the Agent MCP-only boundary.

**Implementation:** Added layered main/group/leaf help for every public CLI command; accepted bare invocation, `help`, `--help`, `-h`, nested help, `version`, `--version`, and `-V`; preserved child `run -- ... --help` arguments. Error JSON keeps `error` and `message` while adding exact `usage`, an actionable or typo-aware `hint`, and a `help` command. The CLI and MCP adapter now share one version constant.

**TDD gate:** RED tests captured the previous `Missing command`, unknown help module, and unsupported version flag. Focused GREEN tests cover all public help topics, command groups, spelling suggestions, missing-option recovery, bare dispatch, version output, and child help passthrough.

**Verification:** `npm run typecheck`, all 82 Vitest tests, the dedicated 2-test acceptance suite, `npm run build`, `cargo test --workspace`, `cargo fmt --check`, and `git diff --check` passed.

## Product feedback: lower-overhead workflows and trustworthy contracts

**Status:** Complete; full verification and blocking review passed (2026-07-18)

**Evidence:** Evaluation Case `45fe83a4-529f-4169-adb4-3792ef896cc1` reports strong exact retrieval and durable knowledge value but weak broad-query precision, unstable MCP schema experience, excessive fixed workflow cost, cold/truncated disk attribution risk, and awkward candidate promotion. Verified SMS Case `69487af3-c34c-4634-bc0c-fc68e4b02f14` contains both a candidate and a later duplicate verified RootCause with the same explanation, confirming the missing in-place promotion path. Current daemon metrics show checkpoint P50/P95 near 8/15ms and finalize near 28/41ms; disk start/finish dominate at roughly 2.1s/1.5s P50, so workflow round trips and payload size—not SQLite write latency—are the primary target.

**Architecture:** Preserve one project-scoped Rust authority and the direct MCP-only Agent boundary. Add light/standard/full caller profiles in the Agent contract; make disk observation conditional on artifact-producing work; keep default query Case-diverse at five compact cards with explicit standard expansion; publish exact MCP schemas for explanations, diagnostics, and Preflight cards; add an idempotent project-owned in-place node promotion operation; and make truncated baselines incapable of claiming pre-existing paths were created by the current observation.

**Acceptance:** Small read-only questions require only project resolution plus query/get-case; implementation uses preflight and a final checkpoint; only artifact-producing or long-running work uses disk observation and full finalization. MCP query defaults to five compact Case-diverse items with expansion through `get_case`; lexical candidates use FTS relevance rather than recency; query/Preflight explanation fields pass MCP output validation; `promote_root_cause` reuses the candidate node ID; Case verification requires one connected RootCause→Solution→Verification chain; and incomplete disk scans never claim growth or cleanup eligibility.

**Verification:** `npm run typecheck`, all 92 Vitest tests, `npm run build`, `cargo test --workspace`, `cargo fmt --check`, and `git diff --check` passed. Two blocking review rounds ended with zero Critical and zero Important findings and a ready-to-merge verdict.

## Protocol reliability and daemon observability

**Status:** Complete; blocking review and release gates passed (2026-07-18)

**Scope:** Eliminate ambiguous-write retry risk, retain validation detail, move metrics to the persistent daemon, improve bounded retrieval diversity, and make strict promotion requirements actionable.

**Implementation:** Added project-scoped durable operation-result lookup; bounded project-owned native daemon metric aggregation; bounded dynamic `VALIDATION_FAILED` messages and MCP field paths; default Case-diverse query results with explicit `nodes` compatibility mode; and promotion `nextActions` plus an explicit `close_case` promotion description. The change is additive under protocol generation 2 and requires no SQLite migration.

**TDD gate:** New MCP, native HTTP, storage transaction, query, and promotion assertions failed before implementation. Focused suites, 59/59 Vitest tests, the complete Rust workspace suite, production build, formatting, and diff checks pass after implementation. The repository's `test:acceptance` script currently selects a missing `tests/acceptance` directory and therefore reports “No test files found”; no acceptance test was silently skipped or claimed as passing.

## Rust Core Migration

**Status:** Stage 5 complete; Stage 6 in progress (2026-07-16)

The executable Stage 0-8 plan is in
`docs/plans/2026-07-16-rust-core-migration-tdd.md`. Rust now owns the read
contract, query-only schema-v7 retrieval, Preflight policy, deterministic
project/domain/k-core hierarchy, and bounded trust-aware PPR. TypeScript
remains the installed writer and daemon. Rust transactional writes now cover
commands, all causal nodes, lifecycle/relevance/merge, checkpoints, and
finalization; project/import/export and migration/recovery remain before write
parity. Native daemon packaging and installed-state acceptance follow. Writes
are never dual-routed.

## Final Review Fix Wave

**Status:** Complete (2026-07-13)

Added stateful argv redaction, Verification environment allowlisting, failed-run Case evidence, explicit human-confirmed promotion, relevance-first preflight, cwd ownership validation, bounded redacted snapshot import, corrected MCP contracts, private database/log permissions, ownership migration triggers, hardened raw logs, snapshot-safe HTTP/SSE behavior, stale-safe browser reads, clean builds, command lifecycle events, and grouped JSON test-report imports.

## Remaining Re-review Fix Wave

**Status:** Complete (2026-07-13)

Closed the six remaining findings: snapshot imports cannot confer verified trust; snapshot export/import resource bounds precede recursive work; preflight matches and scores the complete project-scoped candidate set before limiting; RootCause failed-Attempt links require exact failed outcomes; complete validated raw-log artifact metadata persists through CLI/MCP command recording; and browser Case selection rejects stale same-project responses. The release gate passes with 146 Vitest tests, one acceptance test, and two Chromium tests.

## Final Path-Boundary Fix Wave

**Status:** Complete (2026-07-13)

Closed the final two findings test-first. `KnowledgeService` now derives its service-data boundary from a file-backed database path or accepts an explicit boundary for in-memory use; command-log metadata and legacy paths are canonicalized and limited to that boundary or the selected project's roots. Snapshot import canonicalizes and validates every non-external Artifact row and linked Artifact-node URI before its transaction, rejects `/etc`, sibling-project, and symlink escapes atomically, and leaves external references untouched.
