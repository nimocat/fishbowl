# ADR-20260718: Single finalization and equivalent-node reuse

## Status

Accepted

## Context

Agents sometimes called `checkpoint_work` after implementation and then called
`finalize_work` after commit to add Git facts. Different operation IDs made
both writes individually idempotent, but each aggregate created an Attempt,
RootCause, and Solution. Repeated valid calls therefore made one Case noisy.
Disk observation and mandatory checkpoints also imposed disproportionate cost
on small configuration changes.

## Decision

- Treat `finalize_work` as the one final delivery write after commit and
  verification. A routine completed task does not first call `checkpoint_work`.
- Reserve `checkpoint_work` for context compaction, interruption, cross-day
  pause, or handoff. A later finalization must pass its `caseId`.
- In `finalize_work`, reuse an existing checkpoint-produced, same-project,
  same-Case Attempt only when its complete redacted canonical data and Problem
  target match.
  Ordinary low-level Attempts remain distinct. Reuse RootCause and
  Solution only when their redacted canonical data and causal target match
  exactly; desired failed-Attempt links must already exist.
- Never perform fuzzy node merging during a write. New or materially different
  facts remain new immutable nodes.
- Default omitted MCP merge disposition to `not-required` and publish concrete
  string item schemas for semantic arrays.
- Human Verification and Case closure require explicit real-person confirmation.
- Disk observation was subsequently retired in full by
  `ADR-20260719-explicit-curation-and-disk-observation-retirement.md`.

## Consequences

Correctly disciplined agents produce one concise delivery chain. A necessary
checkpoint can still be safely enriched with commit and Verification facts
without duplicating exact knowledge. The narrow equality rules may retain
near-duplicates with materially different wording; this is safer than silently
collapsing distinct causal history. Existing duplicates are not rewritten or
deleted automatically.

## Alternatives Considered

- Relying only on prompt discipline was rejected because API-level safe reuse
  cheaply protects the graph from a common caller mistake.
- Fuzzy similarity deduplication during writes was rejected because false
  merges would corrupt immutable engineering history.
- Making every small task run checkpoint plus disk observation was rejected
  because its latency and context cost exceed its memory value.
