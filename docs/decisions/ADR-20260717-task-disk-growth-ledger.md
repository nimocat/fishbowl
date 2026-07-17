# ADR-20260717: Conservative task disk-growth ledger

## Status

Accepted for implementation; installed cutover pending release gates.

## Context

Coding agents create build products, dependency caches, generated output, and temporary files across long-running projects and worktrees. Raw volume growth is not enough to decide what can be removed, while a full content index would create privacy, latency, and ownership risks. Concurrent agent tasks also make exclusive attribution unsafe.

## Decision

Rust captures bounded metadata-only snapshots at task start and finish for allowlisted regenerable directory names. SQLite stores project-relative paths, artifact kind, byte counts, deltas, task timestamps, and overlap count. A newly observed non-temporary path may be `eligible`; growth in an existing path is `review`; every overlapping observation is `shared`. Candidate queries consider only the latest completed state for each path. CLI and MCP expose lifecycle and read operations, but no deletion operation exists.

The scanner does not follow symlinks, enter `.git`, read file contents, persist a home/project absolute path, or scan beyond fixed depth, entry, and path budgets. Idempotency keys make lifecycle retries safe. Project references remain explicit and ownership is checked before scanning.

## Consequences

The ledger provides explainable cleanup provenance without pretending concurrent work is exclusively attributable. A first cold scan of a large multi-worktree checkout can reach the 250,000-entry bound; the measured YQSK release scan is approximately 3.5 seconds. Persistent measurement caching or platform-optimized metadata traversal is the next performance slice. Any future cleanup mutation requires a separate ADR, fresh ownership validation, explicit user authorization, and rollback-safe behavior.
