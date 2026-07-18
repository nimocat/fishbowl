# MCP Agent Session Prompt

Install and configure Fishbowl outside the agent session, then copy the following prompt into a coding agent whose client already exposes the user-level `fishbowl` MCP server. For Codex, use the configuration in [MCP Client Configuration](mcp-client-configuration.md).

```text
Use direct Fishbowl MCP tool calls as the local engineering memory for this repository.

Never fall back to the Fishbowl CLI, invoke `node .../dist/cli/main.js`, open Fishbowl's SQLite files, or use a shell wrapper for Fishbowl operations. The CLI is reserved for human installation, diagnostics, and recovery. If Fishbowl MCP is unavailable, follow the missing-capability rule below; continue the core task only when it is safe to omit Fishbowl persistence.

Treat MCP tool discovery as the only agent-side Fishbowl discovery path. Do not search for, locate, or invoke a Fishbowl CLI executable; do not run `where`, `which`, `Get-Command`, package scripts, or filesystem searches to find one. A CLI path or stdio command shown in installation documentation is an MCP Host process descriptor, not an instruction for the agent shell.

If the `fishbowl` MCP namespace or a required Fishbowl MCP tool is missing, stop Fishbowl-specific work, report the missing MCP capability, and ask the user to configure or restart the MCP client. Do not substitute shell, daemon HTTP, direct SQLite, or another tool namespace. Core repository work may continue only when it is safe to omit Fishbowl persistence.

Choose the smallest workflow profile that fits the work, and escalate if risk or scope grows. Project resolution means calling `resolve_project` with the current repository root; if it is not registered, call `register_project` once with that explicit root.

- LIGHT — a read-only question, status/configuration check, or small fact lookup. Resolve the project once per session, call `query_knowledge` only when history is relevant, and expand at most the best Case with `get_case` summary. Do not call `get_preflight_guidance`, disk observation, or checkpoint tools for a LIGHT task unless the task unexpectedly produces a reusable engineering fact.
- STANDARD — an ordinary bounded code, documentation, or configuration change, or bounded debugging. Resolve the project, call brief `get_preflight_guidance` with limit 3, query relevant history, expand only selected Cases, and write one checkpoint after verification when the result is notable. Routine success needs no checkpoint.
- FULL — a deployment, migration, production incident, security/data-sensitive change, destructive change, cross-day investigation, or complex handoff. Resolve, preflight, query and selectively expand relevant Cases; finalize or checkpoint verified facts and use idempotency lookup after ambiguous writes.

Default `query_knowledge` to at most 5 results and prefer Case-diverse compact results. Use `get_case` to expand only a selected Case. A verified blocking Guardrail is never skipped merely because the result limit is small.

Only use disk observation when the task is expected to create material regenerable artifacts, such as a build, dependency install, code generation, package, model compilation, retained test report, cache-growth investigation, or explicit before/after disk accounting. Do not scan disk for pure queries, status/configuration checks, documentation-only work, Git inspection, or small edits with no retained artifacts.

During work, use project-scoped MCP write tools only for useful, redacted engineering facts. Never store secrets, full logs, credentials, environment values, user media, or private chat transcripts.

Before completing STANDARD or FULL work that produced notable reusable knowledge, call `checkpoint_work` or `finalize_work` with the explicit project reference, objective, key decision, files changed, observed verification result, and unresolved risks. Do not force a write for a routine LIGHT answer. The MCP tool records evidence; it does not execute Git or verification commands.

If an idempotent write returns an ambiguous transport or output-validation failure, call `get_operation_result` with the same explicit project, `operationId`, and operation kind before retrying. Retry only when no durable result exists.

Do not expose Fishbowl's local data directory, raw logs, loopback browser, or MCP stdio process to untrusted users.
```
