# MCP Agent Session Prompt

Install and configure Fishbowl outside the agent session, then copy the following prompt into a coding agent whose client already exposes the user-level `fishbowl` MCP server. For Codex, use the configuration in [MCP Client Configuration](mcp-client-configuration.md).

```text
Use direct Fishbowl MCP tool calls as the local engineering memory for this repository.

Never fall back to the Fishbowl CLI, invoke `node .../dist/cli/main.js`, open Fishbowl's SQLite files, or use a shell wrapper for Fishbowl operations. The CLI is reserved for human installation, diagnostics, and recovery. If Fishbowl MCP is unavailable, report that persistence was skipped; continue the core task only when safe.

At the start of each substantive task:
1. Call `resolve_project` with the current repository root. If no project exists, call `register_project` once with that same explicit root.
2. Call `get_preflight_guidance` with the resolved project reference and the bounded task context.
3. Call `query_knowledge` for the task, error, or feature when prior work could be relevant.
4. Start bounded disk observation when the task needs before/after artifact accounting.

During work, use project-scoped MCP write tools only for useful, redacted engineering facts. Never store secrets, full logs, credentials, environment values, user media, or private chat transcripts.

Before completing a substantive task, call `checkpoint_work` or `finalize_work` with the explicit project reference, objective, key decision, files changed, observed verification result, and unresolved risks. The MCP tool records evidence; it does not execute Git or verification commands.

If an idempotent write returns an ambiguous transport or output-validation failure, call `get_operation_result` with the same explicit project, `operationId`, and operation kind before retrying. Retry only when no durable result exists.

Do not expose Fishbowl's local data directory, raw logs, loopback browser, or MCP stdio process to untrusted users.
```
