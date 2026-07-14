# ADR-20260714: Bounded Indexed Case Operations

## Status

Accepted

## Context

Real troubleshooting Cases can accumulate hundreds of nodes and events. The original compatible API returned complete Case history, searched durable JSON with `LIKE`, loaded every project node for preflight, and loaded every Case edge before cycle validation. Service execution remained fast at the current scale, but response payload growth and linear scans created avoidable scaling risk.

## Decision

Keep SQLite and all existing write commands, while adding schema-v6 Case ownership and adjacency indexes. Default Case reads return the graph without history; full history is cursor-paged. Text search uses project-scoped FTS5 candidates, and cycle validation uses a Case-local recursive reachability query. Add an atomic idempotent checkpoint that dispatches existing validated writes. Keep performance telemetry process-local, bounded to 1,000 scalar samples, and expose aggregates without content.

## Consequences

- Existing schema-v5 databases upgrade transactionally and existing callers remain valid.
- Query and mutation SQL retains explicit project or Case ownership.
- Large response size and history work are bounded by caller-selected projections and limits.
- FTS candidate limits trade exhaustive free-text scanning for predictable preflight cost; complete verified Guardrail evaluation is preserved.
- Metrics reset on process restart and are diagnostic rather than durable analytics.

## Alternatives Considered

- External graph/search database: rejected because current scale does not justify a second authority or migration burden.
- Persisted request traces: rejected because they increase write load and risk retaining sensitive content.
- Whole-Case snapshots only: rejected because callers still need bounded history and causal graph access independently.
