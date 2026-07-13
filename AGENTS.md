# Agent Instructions

- Keep `docs/agent-log.md`, `docs/implementation-plan.md`, `CONTEXT.md`, ADRs, and `docs/handoff.md` current during substantial work.
- Follow test-driven development for behavior changes.
- Keep SQLite project scoping explicit in every query and mutation.
- Never persist raw logs, environment values, or unredacted excerpts in SQLite.
- Run `npm run typecheck`, `npm test`, and `npm run build` before declaring completion.
