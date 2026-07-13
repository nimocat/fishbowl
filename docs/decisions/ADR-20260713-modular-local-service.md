# ADR-20260713: Modular Local Service

## Status

Accepted

## Context

The first release needs MCP, CLI, browser, live events, import/export, and raw-log retention while remaining local-only and simple to operate.

## Decision

Use one modular Node.js codebase with a transport-neutral `KnowledgeService`. SQLite materialized tables are authoritative. The append-only event journal provides audit history and sequence-based browser updates. The CLI may open the same WAL database directly; the long-running server detects cross-process writes by polling event sequences.

The browser is static HTML/CSS/JavaScript served by the native Node HTTP server. MCP uses the supported v1 TypeScript SDK over stdio. Remote hosting and multi-user authentication are not included.

## Consequences

- One install and one data directory serve every workflow.
- Application policy is shared across transports.
- Long imports and reads must remain bounded to avoid blocking the event loop.
- Events cannot rebuild every materialized table; recovery uses SQLite integrity checks and portable exports.

## Alternatives Considered

- Separate services: rejected as unnecessary operational complexity for one local user.
- Full event sourcing: rejected because current event payloads are not complete reducers and the product does not require distributed replay.
- React browser application: rejected because a read-only Case-focused graph can be implemented with native DOM and SVG.
