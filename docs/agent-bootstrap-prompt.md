# MCP Agent Session Prompt

Install and configure Fishbowl outside the agent session, then copy the following prompt into a coding agent whose client already exposes the user-level `fishbowl` MCP server. For Codex, use the configuration in [MCP Client Configuration](mcp-client-configuration.md).

```text
Use direct Fishbowl MCP tool calls as the local engineering memory for this repository.

Never fall back to the Fishbowl CLI, invoke `node .../dist/cli/main.js`, open Fishbowl's SQLite files, or use a shell wrapper for Fishbowl operations. The CLI is reserved for human installation, diagnostics, and recovery. If Fishbowl MCP is unavailable, follow the missing-capability rule below; continue the core task only when it is safe to omit Fishbowl persistence.

Treat MCP tool discovery as the only agent-side Fishbowl discovery path. Do not search for, locate, or invoke a Fishbowl CLI executable; do not run `where`, `which`, `Get-Command`, package scripts, or filesystem searches to find one. A CLI path or stdio command shown in installation documentation is an MCP Host process descriptor, not an instruction for the agent shell.

If the `fishbowl` MCP namespace or a required Fishbowl MCP tool is missing, stop Fishbowl-specific work, report the missing MCP capability, and ask the user to configure or restart the MCP client. Do not substitute shell, daemon HTTP, direct SQLite, or another tool namespace. Core repository work may continue only when it is safe to omit Fishbowl persistence.

Choose the smallest workflow profile that fits the work, and escalate if risk or scope grows. Project resolution means calling `resolve_project` with the current repository root; if it is not registered, call `register_project` once with that explicit root.

- LIGHT — a read-only question, status/configuration check, or small fact lookup. Resolve the project once per session, call `query_knowledge` only when history is relevant, and expand at most the best Case with `get_case` summary. Do not call `get_preflight_guidance` or checkpoint tools for a LIGHT task unless the task unexpectedly produces a reusable engineering fact.
- STANDARD — an ordinary bounded code, documentation, or configuration change, or bounded debugging. Resolve the project, call brief `get_preflight_guidance` with limit 3, query relevant history, expand only selected Cases, create a Problem when a concrete reusable issue is first observed, and after commit plus verification call `finalize_work` once when the result is notable. Routine success needs no write.
- FULL — a deployment, migration, production incident, security/data-sensitive change, destructive change, cross-day investigation, or complex handoff. Resolve, preflight, query and selectively expand relevant Cases; create a Problem when the issue is concrete; Record each investigation-changing failed Attempt immediately; then call `finalize_work` once after final commit and verification.

Default `query_knowledge` to at most 5 results and prefer Case-diverse compact results. Use `get_case` to expand only a selected Case. A verified blocking Guardrail is never skipped merely because the result limit is small.

During work, use project-scoped MCP write tools only for useful, redacted engineering facts. Never store secrets, full logs, credentials, environment values, user media, or private chat transcripts.

Keep one engineering problem per Case. Authentication, video editing performance, and upload transport are separate Cases even when one delivery touches all three. Reuse a Case only when the new observation has the same concrete problem boundary and fingerprint.

Record each investigation-changing failed Attempt immediately with `record_attempt` and a stable `sourceKey`; do not wait for the final summary. At finalization, pass those node IDs through `failedAttemptIds` instead of repeating their text. Use a stable fingerprint for the Problem and stable source keys for low-level facts.

Use `checkpoint_work` only for a real context compaction, interruption, cross-day pause, or handoff before final delivery. Do not call it merely because implementation is complete, and do not follow it with a second full set of facts. If finalization follows a necessary checkpoint, pass both its `caseId` and `checkpointOperationId`; Fishbowl explicitly reuses that checkpoint's Attempt, RootCause, and Solution even when the final wording is refined. After final commit and verification, call `finalize_work` once with the explicit project reference, Case, objective, key decision, files changed, observed verification result, and unresolved risks. Its string collections are arrays; omit `merge` when the correct disposition is `not-required`. Do not force a write for a routine LIGHT answer.

When a new Solution changes direction rather than merely refining the old one, call `supersede_solution` to retire the prior Solution and create the explicit `SUPERSEDES` relationship. Never leave an obsolete compression, deployment, or transport direction active beside its replacement.

Never infer human Verification from an automated test, simulator, screenshot, or expected behavior. Record human Verification, promote the confirmed RootCause in place when required, and call `close_case` only after the user explicitly confirms the real target behavior, such as successful access from the Windows machine.

If an idempotent write returns an ambiguous transport or output-validation failure, call `get_operation_result` with the same explicit project, `operationId`, and operation kind before retrying. Retry only when no durable result exists.

Do not expose Fishbowl's local data directory, raw logs, loopback browser, or MCP stdio process to untrusted users.
```
