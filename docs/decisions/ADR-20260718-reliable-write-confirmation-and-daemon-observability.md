# ADR: Reliable write confirmation and daemon-owned observability

Date: 2026-07-18
Status: accepted

## Context

An idempotent checkpoint could commit successfully in the native daemon and
then be reported as failed when a stale MCP output schema rejected optional
`null` fields. Per-MCP-process metrics also disappeared when the stdio bridge
restarted, Rust write validation collapsed distinct field failures into one
`INVALID_ARGUMENT`, and node-ranked retrieval could fill a bounded result with
several nodes from the same Case.

## Decision

- Add project-scoped `getOperationResult` daemon RPC and
  `get_operation_result` MCP tools over the existing `operation_results`
  table. A caller checks the durable result with the original `operationId`
  and optional operation kind before retrying an ambiguous write.
- Aggregate a bounded 1,000-sample metric window in the persistent native
  daemon. Every sample and metrics query resolves an explicit project; MCP
  returns only project-owned daemon counts and native dispatch latency. MCP
  process-local timings are not overlaid because they lack project attribution.
  `daemonPhaseDetail: "dispatch-total"` states that lock acquisition, native
  work, and result encoding are one measured phase; queue and serialization
  sub-phases remain zero rather than being presented as separately measured.
- Preserve bounded request-shape (including a 512-character parser-detail cap)
  and native write-validation messages across
  the protocol; semantic write failures use `VALIDATION_FAILED`, and MCP
  `finalize_work` cross-field checks attach paths before dispatch.
- Make `query_knowledge` Case-diverse by default. `resultMode: "nodes"`
  preserves node-level expansion for callers that need the previous shape.
- Keep promotion policy strict. Promotion responses add bounded `nextActions`
  derived from `missingRequirements`, and `close_case` remains the explicit
  evaluation/promotion operation.

The durable lookup, result mode, and promotion guidance are additive within
protocol generation 2, and no database migration is required. Requiring
`project` on the previously unscoped MCP `get_operation_metrics` input is an
intentional compatibility break: clients of that pre-release tool must add an
explicit project reference so metrics cannot cross project boundaries.

## Consequences

False-negative write responses are recoverable without duplicate nodes.
Metrics survive MCP bridge churn and represent all clients sharing the daemon
for the selected project, but intentionally reset when the daemon itself restarts. Default retrieval has
higher Case diversity; callers needing multiple nodes from one Case opt into
`nodes`. Promotion remains evidence-driven and never manufactures human
confirmation.
