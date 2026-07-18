# ADR-20260719: Explicit graph curation and disk-observation retirement

## Status

Accepted

## Context

Installed use showed stable, fast MCP reads and writes, but graph quality still
suffered when failed Attempts were summarized only at finalization, a
checkpoint and finalization used different wording, or a newer Solution left
its predecessor active. Unrelated engineering problems could also be grouped
into one Case. Disk observations repeatedly returned no tracked paths while
adding latency and workflow complexity. The user requested that the disk
observation feature be removed completely.

## Decision

- Record an investigation-changing failed Attempt immediately with a stable
  `sourceKey`, then pass its ID through `finalize_work.failedAttemptIds`.
- A finalization following a real checkpoint passes
  `checkpointOperationId`. Fishbowl validates that operation in the same
  project and Case and reuses its nodes without fuzzy text matching.
- Add `supersede_solution`. It writes a replacement-to-prior `SUPERSEDES`
  edge, retires the prior Solution, and is operation-idempotent. Default query
  and Preflight omit retired knowledge; explicit status filters can retrieve
  it for history.
- Keep one engineering problem per Case. Authentication, video processing, and
  upload transport are separate Cases even when delivered together.
- Add human Verification and close a Case only after the user explicitly
  confirms the real target behavior.
- Remove disk observation from TypeScript and Rust public contracts, storage
  runtime code, daemon dispatch/watchers, MCP, CLI, tests, and agent guidance.
  Retain the schema-v8/v9 tables only so existing databases upgrade without
  destructive migration or loss of historical rows.

## Consequences

The graph preserves meaningful failures when they happen, avoids duplicate
checkpoint/finalize chains through explicit provenance, and makes superseded
advice quiet by default while retaining audit history. Case boundaries and
human closure remain caller responsibilities but are now explicit policy.
Fishbowl no longer scans project disks or offers cleanup candidates. Existing
disk-observation rows remain inert and readable only through external database
recovery tooling, not normal Fishbowl interfaces.

## Alternatives Considered

- Fuzzy write-time merging was rejected because similar wording can represent
  distinct causal facts.
- Keeping disk observation as an optional or lightweight mode was rejected
  because the user requested complete removal and observed no practical value.
- Dropping historical disk tables was rejected because a destructive schema
  migration would create avoidable upgrade and rollback risk.
