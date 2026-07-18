# Agent Instructions

- Keep `docs/agent-log.md`, `docs/implementation-plan.md`, `CONTEXT.md`, ADRs, and `docs/handoff.md` current during substantial work.
- Follow test-driven development for behavior changes.
- Keep SQLite project scoping explicit in every query and mutation.
- Never persist raw logs, environment values, or unredacted excerpts in SQLite.
- Run `npm run typecheck`, `npm test`, and `npm run build` before declaring completion.

## Fishbowl Access From Codex

- Use direct Fishbowl MCP tool calls for all agent queries and writes.
- Never fall back to the Fishbowl CLI, `node .../dist/cli/main.js`, direct SQLite access, or shell wrappers when MCP is unavailable.
- Treat MCP tool discovery as the only Fishbowl discovery path. Do not search PATH, package scripts, or the filesystem for a Fishbowl CLI executable from an agent session.
- Treat the CLI as a human-operated installation, diagnostics, and recovery interface only.
- If the MCP namespace or required tool is unavailable, report it and ask the user to configure or restart the MCP client. Do not substitute another transport; continue the core task only when omitting Fishbowl persistence is safe.
