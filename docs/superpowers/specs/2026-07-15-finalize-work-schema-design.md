# Fishbowl Precise Schemas and Finalize Work Design

**Date:** 2026-07-15
**Status:** Approved design

## Goal

Reduce Agent write friction by publishing precise MCP schemas and adding one transactional, idempotent `finalize_work` operation for recording an already completed delivery. Fishbowl records Git and verification facts but never executes Git commands.

## Scope

This change:

- makes collection element types and nested delivery fields explicit in MCP JSON Schema;
- adds `finalize_work` to the application service, daemon RPC allowlist, daemon client, and MCP adapter;
- records commit, verification, failed-route, root-cause, solution, and merge facts in one transaction;
- supports appending to an explicit Case or creating a Case;
- permits Case reuse only through an explicit `caseId` or exact normalized fingerprint;
- preserves current promotion and mixed-verification rules.

This change does not execute `git commit`, `git merge`, `git push`, tests, builds, or device validation. It does not infer a merge from repository state and does not persist raw diffs, raw logs, environment variables, or request bodies.

## Public Contract

```ts
interface FinalizeWorkInput {
  project: ProjectReference
  operationId: string
  caseId?: string
  task: string
  outcome: 'succeeded' | 'failed' | 'inconclusive'
  summary: string
  fingerprint?: string
  files?: string[]
  commit?: {
    sha: string
    message: string
    branch?: string
  }
  failedAttempts?: Array<{
    hypothesis: string
    change: string
    failureExplanation: string
    command?: string[]
  }>
  rootCause?: {
    explanation: string
    confidence: number
    evidence: string[]
    rejectedAlternatives?: string[]
  }
  solution?: {
    summary: string
    applicability: string[]
    limitations: string[]
    decisiveDifference: string
  }
  verifications?: Array<{
    kind: 'automated' | 'device' | 'human'
    succeeded: boolean
    command?: string[]
    excerpt: string
    environment?: {
      os?: string
      toolVersion?: string
      architecture?: string
      scheme?: string
      destination?: string
      configuration?: string
    }
    humanConfirmed?: boolean
  }>
  merge: {
    status: 'merged' | 'pending' | 'not-required' | 'conflict'
    sourceBranch?: string
    targetBranch?: string
    mergeCommit?: string
    summary?: string
  }
}

interface FinalizeWorkResult {
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

All strings are trimmed, non-empty, redacted, and bounded by the existing MCP and application payload limits. All arrays are bounded. Commands are non-empty argv arrays. Commit identifiers accept bounded Git object-name strings rather than assuming SHA-1 length.

## Conditional Validation

- `outcome: succeeded` requires `commit`, at least one successful Verification, and the required `merge` disposition.
- `outcome: failed` or `inconclusive` requires at least one `failedAttempts` entry.
- `solution` requires `rootCause` in the same request or an existing RootCause in an explicitly selected Case. The first implementation uses the same-request RootCause to keep behavior deterministic.
- `kind: device` requires `environment.destination` and a non-empty excerpt. It is stored as human evidence with device context. It does not set `humanConfirmed` unless the caller explicitly provides `humanConfirmed: true`.
- `kind: automated` requires a non-empty command.
- `humanConfirmed` is accepted only for `human` or `device` verification.
- An explicit `caseId` must belong to the selected project. Cross-project references fail before mutation.
- With no `caseId`, an exact normalized fingerprint may reuse the matching Problem/Case; otherwise a new Case is created. Text similarity never selects a Case.

## Transaction and Idempotency

`KnowledgeService.finalizeWork` resolves project ownership and validates the complete request before entering one outer SQLite transaction. It then composes existing record operations with deterministic child operation IDs derived from the top-level `operationId`.

The top-level result is stored under operation kind `finalize_work`. A retry returns the original IDs and creates no additional nodes, artifacts, evidence, events, or merge metadata. Any nested validation or ownership failure rolls back the entire operation.

## Graph Mapping

1. Resolve or create the Problem and Case.
2. Add each failed route as an ordered failed Attempt. When appending to a Case, the first new Attempt follows the newest existing Attempt; later new Attempts chain through `PRECEDED_BY`.
3. Add the RootCause as candidate unless existing rules independently permit verified status. The finalize operation itself never infers verification.
4. Add the Solution linked to the RootCause.
5. Add one Verification node for each supplied verification. `device` maps to the existing human Verification representation with the fixed environment allowlist.
6. Store commit and merge facts as bounded local Artifact nodes and Artifact records linked to the Case. They contain identifiers, branch names, status, and summaries only.
7. Return the final promotion status from existing policy evaluation.

Git facts are evidence references, not proof that commands actually ran. Fishbowl preserves caller assertions as structured, reviewable records.

## MCP and Daemon Surface

Add `finalizeWork` to the service contract and daemon operation allowlist, and expose MCP tool `finalize_work`. Existing low-level tools and `checkpoint_work` remain compatible.

The MCP schema uses explicit nested Zod objects. In particular, `files`, `evidence`, `applicability`, `limitations`, `rejectedAlternatives`, and every command item publish `type: string` with non-empty and length constraints. Tool descriptions include concise examples. Validation failures retain SDK paths such as `failedAttempts.0.command.1`.

The output schema is concrete; it does not use `genericRecord` for finalize results.

## Error Handling

Application errors use stable existing codes:

- `VALIDATION_FAILED` for conditional or element-type failures;
- `NOT_FOUND` for missing explicit Cases or required existing nodes;
- `INVALID_ARGUMENT` for inconsistent delivery facts;
- project ownership failures through existing stable project error translation.

No error response includes the full request, evidence text, commit message, or environment data. MCP validation errors may expose field paths and constraint messages only.

## Test Strategy

TDD coverage will prove:

1. MCP discovery exposes precise string item schemas for every affected collection.
2. Successful delivery rejects missing commit, successful verification, or merge disposition.
3. Failed and inconclusive deliveries reject missing failed Attempts.
4. One call records ordered failed routes, RootCause, Solution, automated/device/human verification, commit Artifact, and merge Artifact.
5. Device verification requires destination and does not imply human confirmation.
6. Retry returns identical IDs without duplicate rows or events.
7. Explicit cross-project Case references and malformed nested values roll back without partial writes.
8. Exact fingerprint reuse works; ambiguous text creates a new Case.
9. Existing `checkpoint_work`, low-level MCP tools, promotion rules, daemon transport limits, and snapshot privacy tests remain green.

## Success Criteria

- An Agent can record a completed commit, verification, and merge workflow with one MCP call.
- The published tool schema accurately communicates every nested element type before invocation.
- A valid finalize call is atomic, idempotent, project-scoped, bounded, and redacted.
- Fishbowl records delivery facts without executing Git or expanding its repository permissions.
