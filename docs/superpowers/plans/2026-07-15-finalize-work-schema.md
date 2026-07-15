# EKG Precise Schemas and Finalize Work Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish exact MCP collection schemas and add one atomic, idempotent `finalize_work` operation that records completed commit, verification, failure, root-cause, solution, and merge facts without executing Git.

**Architecture:** `KnowledgeService.finalizeWork` validates the complete delivery envelope, resolves or creates one Case, and composes existing graph writes inside one outer SQLite transaction. Commit and merge facts become bounded Artifact nodes anchored to the Problem through a new valid `Problem:REFERENCES:Artifact` relation; daemon and MCP remain thin adapters. Existing `checkpoint_work` and low-level tools remain compatible.

**Tech Stack:** Node.js 22, TypeScript 5.8, SQLite/FTS5 through `better-sqlite3`, Zod 3, MCP SDK 1.29, Vitest 3.2.

## Global Constraints

- EKG records Git facts but never executes `git commit`, `git merge`, `git push`, tests, builds, or device validation.
- Every read and mutation remains explicitly project scoped.
- No raw diff, raw log, environment value, request body, or response body may be persisted.
- `operationId` makes the entire finalize operation retry-safe and idempotent.
- Text similarity never chooses an existing Case; only explicit `caseId` or exact normalized fingerprint may reuse one.
- Existing mixed-verification and promotion rules remain authoritative.
- MCP collection schemas publish non-empty bounded string item types rather than broad JSON values.
- Every behavior change follows red-green TDD.

---

## File Structure

- `src/application/contracts.ts`: finalize input/result and nested delivery types.
- `src/application/finalize-work.ts`: pure cross-field validation and verification normalization; no database access.
- `src/application/knowledge-service.ts`: transactional graph composition, exact Case resolution, delivery Artifact persistence, and operation replay.
- `src/domain/graph-rules.ts`: permit a Problem to reference a delivery Artifact.
- `src/daemon/protocol.ts`, `src/daemon/operations.ts`, `src/daemon/client.ts`: versioned RPC allowlist and backend proxy.
- `src/mcp/server.ts`: precise reusable string-array schemas and concrete `finalize_work` tool contract.
- `tests/application/finalize-work.test.ts`: service validation, graph mapping, rollback, and idempotency.
- `tests/domain/graph-rules.test.ts`: delivery Artifact relation rule.
- `tests/mcp/server.test.ts`: discovery, exact JSON Schema, validation paths, and end-to-end MCP call.
- `tests/daemon/server.test.ts`: finalize dispatch and replay through authenticated RPC.
- `tests/acceptance/finalize-workflow.test.ts`: one realistic delivery handoff journey.
- `README.md`, `CONTEXT.md`, `docs/mcp-client-configuration.md`, `docs/agent-log.md`, `docs/handoff.md`: operating contract and verification evidence.

---

### Task 1: Finalize Contracts and Pure Conditional Validation

**Files:**
- Create: `src/application/finalize-work.ts`
- Modify: `src/application/contracts.ts`
- Create: `tests/application/finalize-work-validation.test.ts`

**Interfaces:**
- Produces `FinalizeWorkInput`, `FinalizeVerificationInput`, `FinalizeWorkResult`.
- Produces `validateFinalizeWork(input): void` and `normalizeFinalizeVerification(input): VerificationData`.
- Consumes existing `ProjectReference`, `PromotionStatus`, and `VerificationData`.

- [ ] **Step 1: Write failing contract-validation tests**

Add table-driven tests proving successful work requires commit and a successful verification, failed/inconclusive work requires a failed Attempt, automated verification requires argv, device verification requires destination, and `humanConfirmed` is invalid for automated verification:

```ts
expect(() => validateFinalizeWork({
  ...base,
  outcome: 'succeeded',
  commit: undefined,
  verifications: [{ kind: 'automated', succeeded: true, command: ['npm', 'test'], excerpt: 'pass' }],
})).toThrow(/commit is required/i)

expect(() => validateFinalizeWork({
  ...base,
  outcome: 'failed',
  failedAttempts: [],
})).toThrow(/failedAttempts/i)

expect(() => normalizeFinalizeVerification({
  kind: 'device', succeeded: true, excerpt: 'physical device passed', environment: {},
})).toThrow(/destination/i)
```

- [ ] **Step 2: Run validation RED**

Run: `npm test -- tests/application/finalize-work-validation.test.ts`

Expected: FAIL because finalize contracts and module do not exist.

- [ ] **Step 3: Add exact contracts**

Define the approved nested types in `contracts.ts`, including:

```ts
export interface FinalizeVerificationInput {
  kind: 'automated' | 'device' | 'human'
  succeeded: boolean
  command?: string[]
  excerpt: string
  environment?: VerificationData['environment']
  humanConfirmed?: boolean
}

export interface FinalizeWorkResult {
  recorded: true
  createdCase: boolean
  caseId: string
  problemId: string
  attemptIds: string[]
  rootCauseId?: string
  solutionId?: string
  verificationIds: string[]
  artifactIds: string[]
  mergeRecorded: boolean
  promotion: PromotionStatus
}
```

Add `finalizeWork(input: FinalizeWorkInput): FinalizeWorkResult` to `KnowledgeServiceContract`.

- [ ] **Step 4: Implement pure validation and normalization**

`validateFinalizeWork` must reject cross-field inconsistencies before any database mutation. `normalizeFinalizeVerification` maps `device` to existing human Verification data, preserves the fixed environment allowlist, and sets `humanConfirmed` only when explicitly true:

```ts
export function normalizeFinalizeVerification(input: FinalizeVerificationInput): VerificationData {
  if (input.kind === 'automated' && !input.command?.length) {
    throw new KnowledgeServiceError('VALIDATION_FAILED', 'automated verification requires command')
  }
  if (input.kind === 'device' && !input.environment?.destination?.trim()) {
    throw new KnowledgeServiceError('VALIDATION_FAILED', 'device verification requires environment.destination')
  }
  if (input.kind === 'automated' && input.humanConfirmed !== undefined) {
    throw new KnowledgeServiceError('VALIDATION_FAILED', 'automated verification cannot set humanConfirmed')
  }
  return {
    kind: input.kind === 'automated' ? 'automated' : 'human',
    succeeded: input.succeeded,
    excerpt: input.excerpt,
    command: input.command,
    environment: input.environment,
    ...(input.humanConfirmed === true && { humanConfirmed: true }),
  }
}
```

- [ ] **Step 5: Run Task 1 GREEN and commit**

Run: `npm test -- tests/application/finalize-work-validation.test.ts && npm run typecheck`

Expected: PASS.

```bash
git add src/application/contracts.ts src/application/finalize-work.ts tests/application/finalize-work-validation.test.ts
git commit -m "feat: define validated finalize work contract"
```

---

### Task 2: Atomic Service Composition and Delivery Artifacts

**Files:**
- Modify: `src/domain/graph-rules.ts`
- Modify: `src/application/knowledge-service.ts`
- Modify: `src/index.ts`
- Create: `tests/application/finalize-work.test.ts`
- Modify: `tests/domain/graph-rules.test.ts`

**Interfaces:**
- Consumes Task 1 `FinalizeWorkInput`, `FinalizeWorkResult`, `validateFinalizeWork`, and `normalizeFinalizeVerification`.
- Produces `KnowledgeService.finalizeWork(input)`.
- Adds graph relation validity for `Problem:REFERENCES:Artifact` without changing existing `recordArtifactReference` input.

- [ ] **Step 1: Write graph-rule and complete-service RED tests**

Assert the new relation is accepted while unrelated Artifact anchors remain invalid. Build a realistic service call with two failed Attempts, RootCause, Solution, automated and device verification, commit, and merged disposition. Assert exact node/edge counts, ordered `PRECEDED_BY`, two Artifact records, and candidate promotion when mixed verification is incomplete.

```ts
expect(() => validateRelation('Problem', 'REFERENCES', 'Artifact')).not.toThrow()

const result = service.finalizeWork({
  project, operationId: 'finalize-1', task: 'Fix device compile', outcome: 'succeeded',
  summary: 'schema-v1 passed on device', files: ['S1Pro.swift'],
  commit: { sha: 'abc1234', message: 'fix: keep schema v1', branch: 'feature/s1' },
  failedAttempts: [{
    hypothesis: 'schema-v2 is supported', change: 'Enabled schema-v2',
    failureExplanation: 'Device compile rejected schema-v2', command: ['xcodebuild', 'test'],
  }],
  rootCause: { explanation: 'schema-v2 unsupported', confidence: 0.95, evidence: ['device compiler output'] },
  solution: { summary: 'Keep schema-v1', applicability: ['S1 Pro'], limitations: ['No schema-v2'], decisiveDifference: 'Restored schema-v1' },
  verifications: [
    { kind: 'automated', succeeded: true, command: ['xcodebuild', 'test'], excerpt: 'tests passed' },
    { kind: 'device', succeeded: true, excerpt: 'iPhone passed', environment: { destination: 'iPhone 17 Pro' } },
  ],
  merge: { status: 'merged', sourceBranch: 'feature/s1', targetBranch: 'main', mergeCommit: 'def5678' },
})
expect(result).toMatchObject({ recorded: true, attemptIds: [expect.any(String)], verificationIds: [expect.any(String), expect.any(String)], artifactIds: [expect.any(String), expect.any(String)], mergeRecorded: true })
```

- [ ] **Step 2: Run service RED**

Run: `npm test -- tests/domain/graph-rules.test.ts tests/application/finalize-work.test.ts`

Expected: FAIL because the relation and service method are absent.

- [ ] **Step 3: Implement transactional finalize flow**

Before mutation, call `assertPayload` and `validateFinalizeWork`. Inside one outer transaction:

1. Replay stored `finalize_work` result when `operationId` exists.
2. Resolve explicit Case and its Problem, or call `recordProblem` with `${operationId}:problem`; exact fingerprint reuse is inherited from `recordProblem`.
3. Chain failed Attempts through the newest existing Attempt and then each newly created Attempt.
4. For a succeeded delivery, add one succeeded Attempt whose decisive difference is `solution.decisiveDifference` or `summary`; include its ID in `attemptIds`.
5. Record candidate RootCause and Solution with deterministic child operation IDs.
6. Record supplied Verifications against the Solution. If Verifications are supplied without a Solution, reject during pure validation.
7. Persist commit and merge delivery Artifacts with a private helper anchored from Problem.
8. Store and return the top-level result.

The private delivery helper must use bounded Artifact data and metadata:

```ts
private recordDeliveryArtifact(input: {
  projectId: string; caseId: string; problemId: string
  kind: 'git-commit' | 'git-merge'; uri: string; metadata: Record<string, unknown>
}): { nodeId: string; artifactId: string } {
  const node = this.graph.addNode(input.caseId, {
    type: 'Artifact', status: 'candidate',
    data: this.prepareNodeData('Artifact', { kind: input.kind, uri: input.uri }, input.projectId),
  })
  this.graph.addEdge(input.caseId, {
    sourceId: input.problemId, relation: 'REFERENCES', targetId: node.id,
  })
  // Insert the redacted metadata into artifacts and append artifact.recorded using existing columns.
  return { nodeId: node.id, artifactId }
}
```

Use non-file URIs `git:commit:<sha>` and `git:merge:<sha-or-status>` with `is_external = 1`; no repository read occurs.

- [ ] **Step 4: Add rollback, replay, project isolation, and Case-selection tests**

Prove:

- same `operationId` returns identical IDs and unchanged node/event counts;
- invalid second verification rolls back the Problem and first verification;
- a Case from another project returns a stable ownership/not-found error and creates no rows;
- exact fingerprint reuses the existing Case;
- similar task text without fingerprint creates a distinct Case.

- [ ] **Step 5: Run Task 2 GREEN and commit**

Run: `npm test -- tests/domain/graph-rules.test.ts tests/application/finalize-work-validation.test.ts tests/application/finalize-work.test.ts tests/application/knowledge-service.test.ts`

Expected: PASS.

```bash
git add src/domain/graph-rules.ts src/application/knowledge-service.ts src/index.ts tests/domain/graph-rules.test.ts tests/application/finalize-work.test.ts
git commit -m "feat: record atomic finalized delivery workflows"
```

---

### Task 3: Precise MCP Schema and Daemon Proxy

**Files:**
- Modify: `src/mcp/server.ts`
- Modify: `src/daemon/protocol.ts`
- Modify: `src/daemon/operations.ts`
- Modify: `src/daemon/client.ts`
- Modify: `tests/mcp/server.test.ts`
- Modify: `tests/daemon/server.test.ts`

**Interfaces:**
- Consumes Task 2 `KnowledgeService.finalizeWork`.
- Produces daemon operation `finalizeWork` and MCP tool `finalize_work`.
- Refines schemas for `checkpoint_work` and `finalize_work` without changing accepted valid inputs.

- [ ] **Step 1: Write MCP discovery/schema RED tests**

Inspect `client.listTools()` and assert:

```ts
const tool = tools.find((item) => item.name === 'finalize_work')!
expect(tool.inputSchema.required).toEqual(expect.arrayContaining([
  'project', 'operationId', 'task', 'outcome', 'summary', 'merge',
]))
const schema = JSON.stringify(tool.inputSchema)
expect(schema).toContain('failedAttempts')
expect(schema).toContain('destination')
expect((tool.inputSchema.properties?.files as { items?: unknown }).items)
  .toMatchObject({ type: 'string', minLength: 1 })
```

Call `checkpoint_work` and `finalize_work` with `files: [{ path: 'S1.swift' }]` and assert MCP returns an input-validation error containing the field path rather than invoking the service.

- [ ] **Step 2: Run adapter RED**

Run: `npm test -- tests/mcp/server.test.ts tests/daemon/server.test.ts`

Expected: FAIL because `finalize_work` is undiscoverable and daemon rejects the operation.

- [ ] **Step 3: Add reusable exact schemas**

Define schemas with item descriptions instead of broad values:

```ts
const fileList = z.array(
  path.describe('One project-relative or absolute file path string; objects are not accepted.'),
).max(MAX_ARRAY_LENGTH)

const evidenceList = z.array(
  text.describe('One concise evidence statement string; objects are not accepted.'),
).min(1).max(MAX_ARRAY_LENGTH)
```

Use these in both `checkpoint_work` and `finalize_work`. Define strict nested schemas for commit, failed Attempt, RootCause, Solution, Verification, fixed environment, and merge. Use `.superRefine` to mirror application cross-field constraints and attach issues to exact paths.

Register `finalize_work` with a concrete output schema matching `FinalizeWorkResult`, `idempotentWrite` annotations, and a description stating that it records facts but executes no Git command.

- [ ] **Step 4: Add daemon operation and authenticated RPC test**

Append `finalizeWork` to `DAEMON_OPERATIONS`, `METHOD_BY_OPERATION`, and `createDaemonBackend`. Through a real temporary daemon, call `finalizeWork` twice with one request ID and one application operation ID; assert identical result IDs and one Case.

- [ ] **Step 5: Run Task 3 GREEN and commit**

Run: `npm test -- tests/mcp/server.test.ts tests/daemon/server.test.ts tests/daemon/client.test.ts && npm run typecheck`

Expected: PASS.

```bash
git add src/mcp/server.ts src/daemon tests/mcp/server.test.ts tests/daemon
git commit -m "feat: expose precise finalize work MCP tool"
```

---

### Task 4: Acceptance, Documentation, and Release Verification

**Files:**
- Create: `tests/acceptance/finalize-workflow.test.ts`
- Modify: `README.md`
- Modify: `CONTEXT.md`
- Modify: `docs/mcp-client-configuration.md`
- Modify: `docs/agent-log.md`
- Modify: `docs/handoff.md`

**Interfaces:**
- Consumes the public daemon/MCP `finalize_work` operation.
- Produces executable operating examples and final release evidence.

- [ ] **Step 1: Write acceptance RED**

Start a temporary daemon, connect an in-memory MCP client through the daemon backend, register a project, finalize a delivery with failed route plus automated/device verification, then read the Case through a second client. Assert ordered Attempts, RootCause/Solution linkage, commit/merge Artifacts, project isolation, bounded response size, and replay stability.

- [ ] **Step 2: Run acceptance RED, then make only adapter fixes required by the journey**

Run: `npm test -- tests/acceptance/finalize-workflow.test.ts`

Expected before final wiring: FAIL at the first missing or mismatched public contract. Make no new domain behavior in this task; repair only adapter/output mismatches already required by Tasks 1-3.

- [ ] **Step 3: Document the fixed workflow**

Add one README example:

```json
{
  "project": { "projectRoot": "/absolute/project" },
  "operationId": "delivery-s1-20260715",
  "task": "Keep schema-v1 and validate on device",
  "outcome": "succeeded",
  "summary": "Automated and physical-device checks passed",
  "files": ["S1ProFeatureFrontend.swift"],
  "commit": { "sha": "abc1234", "message": "fix: keep schema v1" },
  "verifications": [
    { "kind": "automated", "succeeded": true, "command": ["xcodebuild", "test"], "excerpt": "tests passed" },
    { "kind": "device", "succeeded": true, "excerpt": "device passed", "environment": { "destination": "iPhone 17 Pro" } }
  ],
  "merge": { "status": "merged", "targetBranch": "main", "mergeCommit": "def5678" }
}
```

State explicitly that arrays contain strings, Git is not executed, device evidence does not imply confirmation, and `operationId` must be stable across retries.

- [ ] **Step 4: Run release gates**

Run:

```bash
npm run typecheck
npm test
npm run test:acceptance
npm run build
git diff --check
```

Expected: all pass. Browser tests are not required because this plan changes no browser UI or HTTP routes.

- [ ] **Step 5: Commit documentation and acceptance**

```bash
git add tests/acceptance/finalize-workflow.test.ts README.md CONTEXT.md docs
git commit -m "docs: publish finalized delivery workflow"
```

---

## Final Review Checklist

- [ ] `finalize_work` records facts only and contains no subprocess or Git execution path.
- [ ] Every nested array publishes `items.type = string` where required.
- [ ] Cross-field constraints match in MCP and application validation.
- [ ] Complete-request validation occurs before mutation; transaction rollback is covered.
- [ ] Commit and merge Artifacts contain bounded redacted metadata only.
- [ ] Explicit project ownership and exact fingerprint rules are covered.
- [ ] Retry creates no duplicate nodes, artifacts, evidence, events, or results.
- [ ] Existing `checkpoint_work` and low-level tools remain backward compatible.
- [ ] Full release gates pass and documentation matches actual schemas.
