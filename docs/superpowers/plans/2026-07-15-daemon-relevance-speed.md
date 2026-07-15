# EKG Daemon, Relevance, and Checkpoint Efficiency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make EKG fast and relevant in daily agent workflows by routing CLI/MCP through a persistent cross-platform daemon, returning bounded Case-level Preflight cards, and providing an idempotent concise checkpoint operation.

**Architecture:** A loopback-only daemon becomes the normal SQLite owner. Existing CLI and MCP adapters call a versioned authenticated local RPC protocol, while explicit embedded mode remains for tests and recovery. Query changes rank Cases through exact and FTS signals, compact results to a 12 KiB budget, and use project revisions for cache invalidation; concise checkpoint writes reuse existing graph rules transactionally.

**Tech Stack:** Node.js 22, TypeScript 5.8, Node `http`, SQLite/FTS5/WAL through `better-sqlite3`, Zod 3, MCP SDK 1.29, Vitest 3.2, Playwright 1.61, macOS `launchd`, Windows `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`.

## Global Constraints

- Preserve explicit project scope in every query and mutation.
- Never persist raw logs, request bodies, response bodies, environment values, or unredacted excerpts in SQLite.
- Keep current MCP tool names and low-level write inputs valid.
- Normal CLI/MCP operation must not open SQLite directly or silently enter embedded mode.
- The daemon binds only to loopback and requires an owner-only local token.
- Default Preflight returns at most five Cases and less than 12 KiB encoded JSON.
- Verified knowledge does not expire from age alone.
- Text similarity may propose a merge but must never auto-merge Cases.
- Installation and removal require no administrator privileges and preserve data by default.
- All behavior changes follow red-green TDD.
- Required release gate: `npm run typecheck`, `npm test`, `npm run test:acceptance`, `npm run test:browser` when browser behavior changes, `npm run build`, and `git diff --check`.

---

## File Structure

- `src/daemon/protocol.ts`: versioned RPC request/response types, operation allowlist, limits, and Zod validation.
- `src/daemon/config.ts`: macOS/Windows data locations, token/connection descriptor creation, atomic owner-only writes.
- `src/daemon/server.ts`: authenticated loopback RPC/health server and single database/service lifecycle.
- `src/daemon/client.ts`: bounded HTTP client, health negotiation, one retry with a stable idempotency key.
- `src/daemon/operations.ts`: typed mapping from RPC operation names to `KnowledgeServiceContract` methods.
- `src/daemon/lifecycle.ts`: daemon start/stop/status/ensure logic independent of platform registration.
- `src/daemon/platform.ts`: platform service-manager interface and process-runner boundary.
- `src/daemon/macos-launchd.ts`: user LaunchAgent plist and `launchctl` argument construction.
- `src/daemon/windows-run.ts`: current-user Run-key registration and `reg.exe` argument construction.
- `src/application/backend.ts`: awaitable adapter contract shared by CLI and MCP.
- `src/application/relevance.ts`: token classification, Case scoring, staleness, explanations, and card compaction.
- `src/application/preflight-cache.ts`: bounded project-revision cache.
- `src/application/knowledge-service.ts`: Case candidate loading, card output, checkpoint, relevance, merge proposals, and graph revisions.
- `src/application/contracts.ts`: new cards, detail modes, checkpoint, feedback, merge, daemon metric contracts.
- `src/storage/schema.ts`: schema-v7 project revisions, relevance feedback, and merge proposals.
- `src/cli/arguments.ts`: daemon, doctor, explicit embedded, brief/full Preflight, checkpoint, relevance, and merge commands.
- `src/cli/main.ts`: remote-default lifecycle and explicit embedded dispatch.
- `src/cli/run-command.ts`: awaitable preflight/command-result calls.
- `src/mcp/server.ts`: daemon-compatible awaitable handlers and new high-level tools.
- `src/mcp/stdio.ts`: daemon client startup instead of direct database startup.
- `src/http/server.ts`: authenticated browser session exchange while preserving loopback/same-origin rules.
- `tests/daemon/*.test.ts`: protocol, auth, client, lifecycle, and platform registration.
- `tests/application/relevance.test.ts`: ranking golden set and size/staleness behavior.
- `tests/performance/daemon-relevance-speed.test.ts`: warm latency, payload, and cache regression harness.
- `tests/acceptance/daemon-workflow.test.ts`: remote CLI/MCP and checkpoint journey.
- `.github/workflows/cross-platform-daemon.yml`: macOS/Windows lifecycle and release gates.

---

### Task 1: Versioned Authenticated Daemon Core

**Files:**
- Create: `src/daemon/protocol.ts`
- Create: `src/daemon/config.ts`
- Create: `src/daemon/operations.ts`
- Create: `src/daemon/server.ts`
- Modify: `src/index.ts`
- Test: `tests/daemon/config.test.ts`
- Test: `tests/daemon/server.test.ts`

**Interfaces:**
- Produces `DAEMON_PROTOCOL_VERSION = 1`.
- Produces `DaemonOperation`, `DaemonRequest`, `DaemonSuccess`, and `DaemonFailure`.
- Produces `resolveDaemonPaths(options)`, `ensureDaemonCredentials(options)`, and `readDaemonDescriptor(options)`.
- Produces `startDaemonServer(options): Promise<RunningDaemonServer>`.
- Consumes the existing synchronous `KnowledgeService` and `openDatabase` only inside daemon startup.

- [ ] **Step 1: Write failing config tests**

Test deterministic platform paths, a 32-byte token, owner-only files on POSIX, atomic descriptor replacement, and no token in the public descriptor returned by `readDaemonDescriptor`:

```ts
const paths = resolveDaemonPaths({
  platform: 'darwin',
  home: '/Users/tester',
  environment: {},
})
expect(paths.dataDirectory).toBe('/Users/tester/Library/Application Support/EKG')

const credentials = ensureDaemonCredentials({ paths, randomBytes: () => Buffer.alloc(32, 7) })
expect(credentials.token).toMatch(/^[a-f0-9]{64}$/)
expect(statSync(paths.tokenFile).mode & 0o077).toBe(0)
expect(readDaemonDescriptor({ paths })).not.toHaveProperty('token')
```

- [ ] **Step 2: Run config RED**

Run: `npm test -- tests/daemon/config.test.ts`

Expected: FAIL because `src/daemon/config.ts` does not exist.

- [ ] **Step 3: Implement config and atomic file ownership**

Define:

```ts
export interface DaemonPaths {
  dataDirectory: string
  databasePath: string
  descriptorFile: string
  tokenFile: string
  pidFile: string
  logFile: string
}

export interface DaemonDescriptor {
  protocolVersion: 1
  daemonVersion: string
  host: '127.0.0.1'
  port: number
  instanceId: string
  pid: number
  startedAt: string
}
```

Use `writeFileSync(temp, body, { mode: 0o600, flag: 'wx' })`, `renameSync`, and `chmodSync` on POSIX. Honor `EKG_DATA_DIR` before platform defaults. On Windows use `%LOCALAPPDATA%\\EKG` and rely on the current-user directory boundary while keeping files non-shared.

- [ ] **Step 4: Write failing daemon protocol/auth tests**

Start the daemon against a temporary database and assert:

```ts
expect((await request('/health')).status).toBe(200)
expect((await request('/rpc', { body: validRequest })).status).toBe(401)
expect((await request('/rpc', {
  headers: { authorization: `Bearer ${token}` },
  body: { protocolVersion: 999, requestId: 'r1', operation: 'listProjects', input: {} },
})).status).toBe(409)
expect((await authenticatedRpc('listProjects', {})).body).toEqual({ ok: true, result: [] })
```

Also assert non-loopback Host and cross-origin requests remain rejected, payloads over 64 KiB fail before dispatch, and unknown operations return `INVALID_OPERATION` without echoing the request body.

- [ ] **Step 5: Run daemon RED**

Run: `npm test -- tests/daemon/server.test.ts`

Expected: FAIL because daemon protocol/server modules are absent.

- [ ] **Step 6: Implement RPC protocol and server**

Use an explicit operation allowlist rather than dynamic property access:

```ts
export const daemonOperations = {
  registerProject: (service, input) => service.registerProject(input),
  listProjects: (service) => service.listProjects(),
  resolveProject: (service, input) => service.resolveProject(input),
  updateProject: (service, input) => service.updateProject(input),
  queryKnowledge: (service, input) => service.queryKnowledge(input),
  getCase: (service, input) => service.getCase(input),
  listRecentActivity: (service, input) => service.listRecentActivity(input),
  preflight: (service, input) => service.preflight(input),
  recordProblem: (service, input) => service.recordProblem(input),
  recordAttempt: (service, input) => service.recordAttempt(input),
  recordRootCause: (service, input) => service.recordRootCause(input),
  recordSolution: (service, input) => service.recordSolution(input),
  recordVerification: (service, input) => service.recordVerification(input),
  recordArtifactReference: (service, input) => service.recordArtifactReference(input),
  recordGuardrail: (service, input) => service.recordGuardrail(input),
  recordCheckpoint: (service, input) => service.recordCheckpoint(input),
  recordCommandStarted: (service, input) => service.recordCommandStarted(input),
  recordCommandResult: (service, input) => service.recordCommandResult(input),
  closeCase: (service, input) => service.closeCase(input),
  markRegression: (service, input) => service.markRegression(input),
  previewImport: (service, input) => service.previewImport(input),
  applyImport: (service, input) => service.applyImport(input),
  exportProjectGraph: (service, input) => service.exportProjectGraph(input),
  importProjectGraph: (service, input) => service.importProjectGraph(input),
} satisfies Record<string, DaemonOperationHandler>
```

`startDaemonServer` opens SQLite once, constructs one `KnowledgeService`, starts on `127.0.0.1` with port `0` or the configured port, atomically writes the descriptor after listen succeeds, and closes HTTP/SSE/database in order. `/health` exposes only protocol version, daemon version, instance ID, and status. Keep a bounded in-memory cache of the latest 1,000 request IDs and results for same-process response-loss retries; never persist transport request or response bodies.

- [ ] **Step 7: Run Task 1 GREEN**

Run: `npm test -- tests/daemon/config.test.ts tests/daemon/server.test.ts tests/http/server.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit Task 1**

```bash
git add src/daemon src/index.ts tests/daemon
git commit -m "feat: add authenticated local EKG daemon"
```

---

### Task 2: Thin Daemon Client, CLI, and MCP Proxy

**Files:**
- Create: `src/application/backend.ts`
- Create: `src/daemon/client.ts`
- Create: `src/daemon/lifecycle.ts`
- Modify: `src/cli/arguments.ts`
- Modify: `src/cli/main.ts`
- Modify: `src/cli/run-command.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/mcp/stdio.ts`
- Test: `tests/daemon/client.test.ts`
- Modify: `tests/cli/main.test.ts`
- Modify: `tests/cli/run-command.test.ts`
- Modify: `tests/mcp/server.test.ts`
- Test: `tests/acceptance/daemon-workflow.test.ts`

**Interfaces:**
- Consumes Task 1 RPC endpoints and descriptor.
- Produces `AwaitableKnowledgeBackend`, whose methods return `T | Promise<T>`.
- Produces `DaemonClient.call<K extends DaemonOperation>(operation, input, options): Promise<Result<K>>`.
- Produces `ensureDaemonRunning(options): Promise<DaemonDescriptor>` with one start and one bounded retry.
- Makes normal `runCli` remote by default; `--embedded` is the only direct database path.

- [ ] **Step 1: Write failing client retry and idempotency tests**

Inject an HTTP transport that commits the first request and drops its response. Assert the second attempt uses the identical request ID and receives the stored result:

```ts
const result = await client.call('recordProblem', input, { requestId: 'stable-r1' })
expect(transport.requestIds).toEqual(['stable-r1', 'stable-r1'])
expect(result.nodeId).toBe(firstCommittedNodeId)
expect(countProblemNodes(database)).toBe(1)
```

Assert connect failure invokes `startInstalledService` once, waits no longer than the injected timeout, retries once, and then returns `DAEMON_UNAVAILABLE` with `ekg doctor` guidance.

- [ ] **Step 2: Run client RED**

Run: `npm test -- tests/daemon/client.test.ts`

Expected: FAIL because daemon client/lifecycle modules are absent.

- [ ] **Step 3: Implement bounded client and lifecycle**

Use Node `http.request`, not `fetch`, so connection and total timeouts are explicit. Generate one UUID before the first attempt. Reject descriptors with another protocol version. Never read or write the SQLite path from the client.

Define:

```ts
export type Awaitable<T> = T | Promise<T>
export type AwaitableKnowledgeBackend = {
  [K in keyof KnowledgeServiceContract]:
    KnowledgeServiceContract[K] extends (...args: infer A) => infer R
      ? (...args: A) => Awaitable<R>
      : never
}
```

- [ ] **Step 4: Write CLI/MCP RED tests**

Assert normal CLI calls a fake daemon and never calls injected `openDatabase`; `--embedded --data-dir ...` opens the database. Assert stdio startup constructs a daemon client and no longer calls `openDatabase`.

For `ekg run`, use an awaitable fake backend and assert preflight occurs before child spawn and command result is recorded after completion.

- [ ] **Step 5: Run adapter RED**

Run: `npm test -- tests/cli/main.test.ts tests/cli/run-command.test.ts tests/mcp/server.test.ts`

Expected: FAIL because adapters are synchronous/direct-database only.

- [ ] **Step 6: Refactor adapters to awaitable backend**

Make dispatch asynchronous and await every backend call. Add leading global `--embedded`; reject `--embedded` for `mcp --stdio` unless `--data-dir` is explicit. Keep test helpers using embedded mode. Make MCP tool handlers `await` backend results without changing tool names or current schemas.

Normal `mcp --stdio` reads the daemon descriptor and proxies operations. It writes no banners to stdout.

- [ ] **Step 7: Add remote acceptance journey**

Start a temporary daemon, invoke CLI project register/query/preflight through the descriptor, create an in-memory MCP client over the daemon backend, and assert both see the same project without either adapter opening SQLite.

- [ ] **Step 8: Run Task 2 GREEN**

Run: `npm test -- tests/daemon/client.test.ts tests/cli/main.test.ts tests/cli/run-command.test.ts tests/mcp/server.test.ts tests/acceptance/daemon-workflow.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit Task 2**

```bash
git add src/application/backend.ts src/daemon/client.ts src/daemon/lifecycle.ts src/cli src/mcp tests/daemon tests/cli tests/mcp tests/acceptance/daemon-workflow.test.ts
git commit -m "feat: route CLI and MCP through EKG daemon"
```

---

### Task 3: Case-level Preflight Ranking, Cards, and Size Budget

**Files:**
- Create: `src/application/relevance.ts`
- Create: `src/application/preflight-cache.ts`
- Modify: `src/application/contracts.ts`
- Modify: `src/application/knowledge-service.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/daemon/protocol.ts`
- Test: `tests/application/relevance.test.ts`
- Modify: `tests/application/knowledge-service.test.ts`
- Modify: `tests/mcp/server.test.ts`
- Create: `tests/performance/daemon-relevance-speed.test.ts`

**Interfaces:**
- Produces `PreflightDetail = 'brief' | 'standard' | 'full'`.
- Produces `PreflightCard`, `PreflightMatchReason`, and `PreflightResult.cards`.
- Produces `rankCases(context, candidates, now): RankedCase[]`.
- Produces `compactPreflight(result, maxBytes = 12 * 1024): PreflightResult`.
- Produces `PreflightCache.get/set/invalidateProject` keyed by project graph revision.

- [ ] **Step 1: Write ranking golden-set RED tests**

Build deterministic redacted S1-shaped fixtures:

- a verified schema-v1 RootCause/Solution/Guardrail;
- a rejected schema-v2 failed Attempt;
- CoreML/Metal device compilation evidence;
- a material-filter regression Attempt;
- 100 unrelated generic build/test Attempts in one large Case.

Assert:

```ts
const result = service.preflight({
  project,
  taskDescription: 'Keep S1 Pro schema-v1 and verify CoreML Metal on device',
  changedFiles: ['S1ProFeatureFrontend.swift'],
  command: ['xcodebuild', 'test'],
})
expect(result.cards).toHaveLength(5)
expect(result.cards[0]).toMatchObject({ caseId: schemaCaseId })
expect(result.cards[0].whyMatched).toContainEqual(expect.objectContaining({ kind: 'exact-file' }))
expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(12 * 1024)
expect(result.cards.filter((card) => card.caseId === noisyCaseId)).toHaveLength(1)
```

Assert an exact fingerprint always ranks first; a blocking Guardrail still sets `blocked`; common-only tokens cannot create a card; and an explicit `detail: 'full'` remains bounded.

- [ ] **Step 2: Run ranking RED**

Run: `npm test -- tests/application/relevance.test.ts tests/application/knowledge-service.test.ts`

Expected: FAIL because cards/relevance module are absent and current output exceeds the budget.

- [ ] **Step 3: Implement explainable scoring**

Define bounded weights in one table:

```ts
const WEIGHTS = {
  exactFingerprint: 1000,
  blockingGuardrail: 900,
  exactFileOrTestOrSymbol: 500,
  exactCommand: 350,
  verifiedRootCauseOrSolution: 200,
  applicabilityMatch: 120,
  recentVerification: 80,
  textMatch: 40,
  commonOnlyPenalty: -300,
  candidate30DayPenalty: -80,
  candidate90DayPenalty: -400,
  regressedPenalty: -250,
  retiredOrSupersededPenalty: -1000,
} as const
```

Group nodes by Case before scoring. Select at most one RootCause, one Solution, and one decisive failed Attempt per card. Keep exact fingerprint and verified blocking Guardrail evaluation outside candidate truncation.

- [ ] **Step 4: Implement deterministic compaction**

Trim in this order until under 12 KiB: evidence excerpts, failed-route excerpt, secondary match reasons, then lower-ranked cards. Never remove a blocking Guardrail card. Return `{ truncated, expansionCaseIds }`.

Keep legacy Preflight arrays populated only with the selected compact nodes represented by cards, so current callers still receive the same top-level fields without the unbounded dump.

- [ ] **Step 5: Add project-revision cache**

Implement a 256-entry LRU with no request text persisted outside memory. Cache key is a SHA-256 digest of project ID, graph revision, normalized context, detail, and limit. Service mutations increment the project revision and invalidate only that project's entries.

- [ ] **Step 6: Add deterministic performance tests**

Warm the daemon/service once, run 100 Preflights, and assert p95 service duration below 100 ms on the generated fixture. Assert cache hit avoids the candidate SQL spy, mutation invalidates one project only, default response remains below 12 KiB, and maximum card count is five.

- [ ] **Step 7: Run Task 3 GREEN**

Run: `npm test -- tests/application/relevance.test.ts tests/application/knowledge-service.test.ts tests/mcp/server.test.ts tests/performance/daemon-relevance-speed.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit Task 3**

```bash
git add src/application src/mcp/server.ts src/daemon/protocol.ts tests/application tests/mcp/server.test.ts tests/performance/daemon-relevance-speed.test.ts
git commit -m "perf: rank compact Preflight knowledge cards"
```

---

### Task 4: Concise Idempotent `checkpoint_work`

**Files:**
- Modify: `src/application/contracts.ts`
- Modify: `src/application/knowledge-service.ts`
- Modify: `src/domain/node-data.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/cli/arguments.ts`
- Modify: `src/cli/main.ts`
- Modify: `src/daemon/operations.ts`
- Test: `tests/application/checkpoint-work.test.ts`
- Modify: `tests/mcp/server.test.ts`
- Modify: `tests/cli/main.test.ts`
- Modify: `tests/daemon/client.test.ts`

**Interfaces:**
- Produces `CheckpointWorkInput` and `CheckpointWorkResult`.
- Produces `KnowledgeService.checkpointWork(input)`.
- Produces MCP tool `checkpoint_work` and CLI `ekg checkpoint`.

- [ ] **Step 1: Write minimal failure checkpoint RED test**

```ts
const result = service.checkpointWork({
  project: { projectRoot },
  operationId: 'checkpoint-1',
  task: 'Fix Metal material flicker',
  outcome: 'failed',
  summary: 'Two-pass Gaussian regressed total latency',
})
expect(result).toMatchObject({ recorded: true, createdCase: true })
expect(caseNodes(result.caseId)).toEqual(expect.arrayContaining([
  expect.objectContaining({ type: 'Problem' }),
  expect.objectContaining({ type: 'Attempt', data: expect.objectContaining({ outcome: 'failed' }) }),
]))
```

Retry the identical operation and assert the same IDs and no duplicate nodes.

- [ ] **Step 2: Write capture-policy RED tests**

Assert `importance: 'routine'` plus `outcome: 'succeeded'` returns `{ recorded: false, reason: 'routine-success' }`. Assert failed work always records. Assert supplied RootCause/Solution remain candidate until mixed verification. Assert explicit `caseId` links the prior Attempt; ambiguous similarity without fingerprint creates a new Case rather than guessing.

- [ ] **Step 3: Run checkpoint RED**

Run: `npm test -- tests/application/checkpoint-work.test.ts`

Expected: FAIL because `checkpointWork` does not exist.

- [ ] **Step 4: Implement one-transaction checkpoint composition**

Define:

```ts
export interface CheckpointWorkInput {
  project: ProjectReference
  operationId: string
  caseId?: string
  task: string
  outcome: 'failed' | 'succeeded' | 'inconclusive'
  summary: string
  importance?: 'routine' | 'notable' | 'critical'
  fingerprint?: string
  files?: string[]
  command?: string[]
  evidence?: string[]
  rootCause?: { explanation: string; confidence: number; rejectedAlternatives?: string[] }
  solution?: { summary: string; applicability: string[]; limitations: string[]; decisiveDifference: string }
  humanConfirmed?: boolean
}
```

Use existing `recordProblem`, `recordAttempt`, `recordRootCause`, `recordSolution`, and `recordVerification` inside one outer transaction. Store/replay the top-level operation before returning. Default Attempt hypothesis to the task and change to the summary; preserve explicit optional fields after redaction. Never mark an inferred RootCause verified.

- [ ] **Step 5: Add MCP/CLI adapters test-first**

MCP schema requires the four minimal fields plus project and operation ID. CLI accepts concise flags:

```text
ekg checkpoint --project-root <path> --task <text> --outcome failed --summary <text>
```

It also accepts `--data-json` for optional structured fields, but minimal usage does not require JSON. Ensure proxy-assigned request ID and application operation ID are distinct and both stable across retry.

- [ ] **Step 6: Run Task 4 GREEN**

Run: `npm test -- tests/application/checkpoint-work.test.ts tests/mcp/server.test.ts tests/cli/main.test.ts tests/daemon/client.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit Task 4**

```bash
git add src/application src/domain/node-data.ts src/mcp src/cli src/daemon/operations.ts tests/application/checkpoint-work.test.ts tests/mcp tests/cli tests/daemon/client.test.ts
git commit -m "feat: add concise idempotent work checkpoints"
```

---

### Task 5: Staleness, Relevance Feedback, and Merge Proposals

**Files:**
- Modify: `src/storage/schema.ts`
- Modify: `src/application/contracts.ts`
- Modify: `src/application/relevance.ts`
- Modify: `src/application/knowledge-service.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/daemon/operations.ts`
- Test: `tests/storage/database.test.ts`
- Test: `tests/application/relevance.test.ts`
- Create: `tests/application/merge-proposals.test.ts`

**Interfaces:**
- Migrates schema v6 to v7 without deleting history.
- Produces `reportRelevance(input)`, `suggestCaseMerges(input)`, and `applyCaseMerge(input)`.
- Produces `RelevanceFeedback` and `MergeProposal` contracts.

- [ ] **Step 1: Write schema-v7 migration RED test**

Open a schema-v6 fixture and assert creation of:

```sql
project_revisions(project_id PRIMARY KEY, revision INTEGER NOT NULL)
relevance_feedback(id, project_id, case_id, context_hash, verdict, reason, created_at)
merge_proposals(id, project_id, source_case_id, target_case_id, status, reasons, created_at, resolved_at)
```

Assert indexes are explicitly project-scoped and all existing events/nodes remain unchanged.

- [ ] **Step 2: Run migration RED**

Run: `npm test -- tests/storage/database.test.ts`

Expected: FAIL because schema version remains 6.

- [ ] **Step 3: Implement transactional schema-v7 migration**

Seed one revision row per project. Add ownership triggers preventing cross-project feedback/proposals. Bound stored reasons using existing payload policy. Durable write replay uses the existing project-scoped `operation_results` table by injecting the stable client request ID when a write lacks an operation ID. Read calls and project registration use the daemon's bounded in-memory request cache; do not add a transport-response table.

- [ ] **Step 4: Write staleness and feedback RED tests**

Use an injected clock. Assert candidate penalty after 30 days, default exclusion after 90 days, exact fingerprint recovery, verified no-age-expiry, and superseded/regressed penalties. Record `useful` and `irrelevant` feedback for the same context class and assert ranking changes without node status changes.

- [ ] **Step 5: Write merge-proposal RED tests**

Assert exact fingerprint recording reuses the existing Case. Assert high text/file/test overlap creates a proposal but two Cases remain. Applying an approved proposal creates an explicit consolidation relation/event, marks the proposal applied, preserves both histories and IDs, and is idempotent. Reject cross-project and self merges.

- [ ] **Step 6: Implement feedback and proposals**

Use a redacted SHA-256 context class rather than storing raw query text. Similarity proposal reasons are a bounded enum plus scores: `shared-file`, `shared-test`, `shared-command`, `text-overlap`, and `applicability-overlap`. Applying a proposal never deletes rows.

- [ ] **Step 7: Run Task 5 GREEN**

Run: `npm test -- tests/storage/database.test.ts tests/application/relevance.test.ts tests/application/merge-proposals.test.ts tests/mcp/server.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit Task 5**

```bash
git add src/storage/schema.ts src/application src/mcp/server.ts src/daemon/operations.ts tests/storage tests/application
git commit -m "feat: rank stale knowledge and suggest Case merges"
```

---

### Task 6: macOS and Windows User-level Installation

**Files:**
- Create: `src/daemon/platform.ts`
- Create: `src/daemon/macos-launchd.ts`
- Create: `src/daemon/windows-run.ts`
- Modify: `src/daemon/lifecycle.ts`
- Modify: `src/cli/arguments.ts`
- Modify: `src/cli/main.ts`
- Test: `tests/daemon/macos-launchd.test.ts`
- Test: `tests/daemon/windows-run.test.ts`
- Test: `tests/daemon/lifecycle.test.ts`
- Create: `.github/workflows/cross-platform-daemon.yml`

**Interfaces:**
- Produces `PlatformServiceManager` with `install/start/stop/status/uninstall`.
- Produces `MacLaunchdServiceManager` and `WindowsRunServiceManager`.
- Produces CLI daemon lifecycle and `doctor` commands.

- [ ] **Step 1: Write macOS renderer/argument RED tests**

Assert a plist with `Label`, `ProgramArguments` array, `RunAtLoad=true`, bounded `KeepAlive`, `WorkingDirectory`, and log paths. Assert XML escaping for spaces, ampersands, and non-ASCII paths. Assert structured launchctl arguments:

```ts
expect(manager.installCommands()).toEqual([
  { command: '/bin/launchctl', args: ['bootstrap', `gui/${uid}`, plistPath] },
  { command: '/bin/launchctl', args: ['kickstart', '-k', `gui/${uid}/io.ekg.daemon`] },
])
```

- [ ] **Step 2: Write Windows registration RED tests**

Assert no `cmd.exe`, PowerShell, or shell mode. Assert `reg.exe` receives structured arguments targeting only:

```text
HKCU\Software\Microsoft\Windows\CurrentVersion\Run
```

with value name `EKGDaemon`. Verify correct Windows quoting for Node/CLI/config paths containing spaces and non-ASCII characters. Uninstall deletes only that value. Start/ensure uses detached `node` argv and validates health rather than trusting process creation.

- [ ] **Step 3: Run installer RED**

Run: `npm test -- tests/daemon/macos-launchd.test.ts tests/daemon/windows-run.test.ts tests/daemon/lifecycle.test.ts`

Expected: FAIL because platform managers are absent.

- [ ] **Step 4: Implement injected process runner and managers**

Define:

```ts
export interface ProcessRunner {
  run(command: string, args: string[], options?: { detached?: boolean }): Promise<{ code: number; stdout: string; stderr: string }>
}

export interface PlatformServiceManager {
  install(): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
  status(): Promise<'running' | 'stopped' | 'not-installed' | 'unhealthy'>
  uninstall(): Promise<void>
}
```

Never use `{ shell: true }`. Validate every generated path before writing configuration. Preserve data during uninstall.

- [ ] **Step 5: Add CLI lifecycle and doctor**

Parse and dispatch `ekg daemon install|start|stop|restart|status|uninstall` and `ekg doctor`. Doctor returns bounded JSON with component statuses and timings and never returns the token value. It uses explicit checks; it does not mutate configuration except when the user chose install/start/restart.

- [ ] **Step 6: Add cross-platform CI**

Create a `strategy.matrix.os: [macos-latest, windows-latest]` workflow that runs install/build/typecheck/unit tests. Platform lifecycle tests use isolated user directories and remove only test registrations in `finally`. Do not mutate the developer's real login service during ordinary unit tests.

- [ ] **Step 7: Run Task 6 GREEN**

Run locally: `npm test -- tests/daemon/macos-launchd.test.ts tests/daemon/windows-run.test.ts tests/daemon/lifecycle.test.ts tests/cli/main.test.ts`

Expected: PASS. Verify workflow YAML with the repository's chosen YAML parser or a focused syntax test.

- [ ] **Step 8: Commit Task 6**

```bash
git add src/daemon src/cli .github/workflows/cross-platform-daemon.yml tests/daemon tests/cli/main.test.ts
git commit -m "feat: install EKG daemon on macOS and Windows"
```

---

### Task 7: Browser Authentication, Migration, Benchmarks, and Release Documentation

**Files:**
- Modify: `src/http/server.ts`
- Modify: `src/web/app.js`
- Modify: `tests/http/server.test.ts`
- Modify: `tests/browser/app.test.ts`
- Modify: `tests/browser-e2e/trace-bench.spec.ts`
- Modify: `tests/performance/daemon-relevance-speed.test.ts`
- Modify: `tests/acceptance/daemon-workflow.test.ts`
- Modify: `README.md`
- Modify: `docs/mcp-client-configuration.md`
- Modify: `docs/agent-log.md`
- Modify: `docs/implementation-plan.md`
- Modify: `CONTEXT.md`
- Modify: `docs/handoff.md`
- Create: `docs/decisions/ADR-20260715-daemon-case-ranking.md`

**Interfaces:**
- Consumes all previous tasks.
- Produces one-time browser launch-token exchange and authenticated local session.
- Produces final installation, upgrade, recovery, migration, and performance documentation.

- [ ] **Step 1: Write browser auth RED tests**

Assert API calls without a daemon bearer token or browser session return 401. Assert a valid one-time launch token sets `HttpOnly; SameSite=Strict`, cannot be reused, and redirects to `/` without the token in the URL. Retain loopback Host, same-origin, CSP, response-bound, and SSE tests.

- [ ] **Step 2: Run browser RED**

Run: `npm test -- tests/http/server.test.ts tests/browser/app.test.ts`

Expected: FAIL because current read-only browser API has no daemon session.

- [ ] **Step 3: Implement session exchange**

Keep a bounded in-memory set of expiring one-time tokens and sessions. Hash tokens before comparison, cap active sessions, expire idle sessions, and do not persist browser secrets. SSE requires the same cookie.

- [ ] **Step 4: Complete migration and performance acceptance**

Create a copy of a schema-v6 fixture with the large S1-shaped Case, start the daemon, verify migration/backup, run warm Preflight samples, checkpoint, retry, cache invalidation, and browser update. Assert all budgets from Global Constraints.

- [ ] **Step 5: Update documentation and durable project memory**

README must lead with:

```text
npm install -g engineering-knowledge-graph
ekg daemon install
ekg doctor
ekg mcp --stdio
```

Document macOS/Windows data locations, service lifecycle, explicit `--embedded`, compact Preflight, `checkpoint_work`, upgrade backup, token recovery, uninstall data preservation, and exact MCP configuration. Record the daemon/Case-ranking decision in the ADR and update the project handoff/log/context files required by `AGENTS.md`.

- [ ] **Step 6: Run focused browser and acceptance GREEN**

Run:

```bash
npm test -- tests/http/server.test.ts tests/browser/app.test.ts tests/performance/daemon-relevance-speed.test.ts tests/acceptance/daemon-workflow.test.ts
npm run test:browser
```

Expected: PASS.

- [ ] **Step 7: Run full release gate**

Run:

```bash
npm run typecheck
npm test
npm run test:acceptance
npm run test:browser
npm run build
git diff --check
```

Expected: every command passes. Record test counts and measured p50/p95/maximum response bytes in `docs/handoff.md`; do not claim Windows lifecycle success until the Windows CI job passes.

- [ ] **Step 8: Commit Task 7**

```bash
git add src/http src/web tests README.md docs CONTEXT.md
git commit -m "docs: complete EKG daemon efficiency release"
```

---

## Plan Self-review Results

- Spec coverage: daemon ownership, protocol security, CLI/MCP proxying, bounded relevance, checkpoint ergonomics, staleness, merge proposals, feedback, macOS/Windows install, browser auth, migration, and performance budgets each map to a task.
- Placeholder scan: no deferred implementation placeholders remain.
- Type consistency: daemon operation names, `AwaitableKnowledgeBackend`, `PreflightCard`, `CheckpointWorkInput`, platform manager methods, and test commands are defined before use.
- Scope: seven tasks are ordered so every commit leaves a testable system; embedded compatibility remains until remote adapters pass.
