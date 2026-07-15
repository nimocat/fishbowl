# Complete First Release Implementation Plan

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

**Produces:** `ekg serve`, project/query/preflight/run/case/import/export commands; raw-log SHA-256, mode `0600`, age and size retention; child argv/output/exit preservation; exit `78` for verified guardrail blocks.

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

## Final Review Fix Wave

**Status:** Complete (2026-07-13)

Added stateful argv redaction, Verification environment allowlisting, failed-run Case evidence, explicit human-confirmed promotion, relevance-first preflight, cwd ownership validation, bounded redacted snapshot import, corrected MCP contracts, private database/log permissions, ownership migration triggers, hardened raw logs, snapshot-safe HTTP/SSE behavior, stale-safe browser reads, clean builds, command lifecycle events, and grouped JSON test-report imports.

## Remaining Re-review Fix Wave

**Status:** Complete (2026-07-13)

Closed the six remaining findings: snapshot imports cannot confer verified trust; snapshot export/import resource bounds precede recursive work; preflight matches and scores the complete project-scoped candidate set before limiting; RootCause failed-Attempt links require exact failed outcomes; complete validated raw-log artifact metadata persists through CLI/MCP command recording; and browser Case selection rejects stale same-project responses. The release gate passes with 146 Vitest tests, one acceptance test, and two Chromium tests.

## Final Path-Boundary Fix Wave

**Status:** Complete (2026-07-13)

Closed the final two findings test-first. `KnowledgeService` now derives its service-data boundary from a file-backed database path or accepts an explicit boundary for in-memory use; command-log metadata and legacy paths are canonicalized and limited to that boundary or the selected project's roots. Snapshot import canonicalizes and validates every non-external Artifact row and linked Artifact-node URI before its transaction, rejects `/etc`, sibling-project, and symlink escapes atomically, and leaves external references untouched.
