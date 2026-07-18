# Fishbowl

<p align="center">
  <img src="docs/assets/fishbowl-logo.png" width="196" alt="Fishbowl logo: a diving-goggle brain in a fishbowl" />
</p>

<h2 align="center">Local-first engineering memory for humans and coding agents.</h2>

<p align="center">
  Turn failures, decisions, evidence, and verification into durable project knowledge.<br />
  Search it before the next task. Record only the facts worth keeping.
</p>

<p align="center">
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="docs/agent-bootstrap-prompt.md">Agent quick start</a> ·
  <a href="docs/mcp-client-configuration.md">MCP setup</a> ·
  <a href="SECURITY.md">Security</a> ·
  <a href="LICENSE">MIT License</a>
</p>

---

## Why Fishbowl

Engineering teams often solve the same problem twice: the important context is trapped in terminal scrollback, issue threads, and someone’s memory. Fishbowl keeps a project-local, reviewable record without pretending that every note is a proven fact.

| Keep | Avoid |
| --- | --- |
| Failed attempts, supporting evidence, decisions, fixes, and verification | Raw chat transcripts, credentials, full logs, or a cloud dependency |
| A shared knowledge graph across a repository and its worktrees | Repeating expensive investigations from scratch |
| Local SQLite, loopback-only browser access, and stdio MCP | Unreviewable autonomous “memory” |

## What You Get

- **`fishbowl` CLI** for registering projects, querying context, recording cases, and checking integrity.
- **Persistent local daemon** that owns one authenticated SQLite connection and local cache.
- **stdio MCP server** for compatible coding agents.
- **Trace Bench**, a read-only local browser for inspecting project activity.
- **Worktree-aware project aliases** so parallel branches still share the right engineering context.
- **Bounded disk observations** for regenerable artifact metadata. Fishbowl never deletes files automatically.

## Quick Start

### macOS / Linux

```bash
git clone https://github.com/nimocat/fishbowl.git
cd fishbowl
npm install
npm run build
npm link

fishbowl daemon install
fishbowl daemon doctor
```

### Windows (PowerShell)

Install Node.js 22 or newer, Git, Rust stable with the MSVC toolchain, and the Visual Studio Build Tools C++ workload, then run:

```powershell
git clone https://github.com/nimocat/fishbowl.git
Set-Location fishbowl
npm install
npm run build
npm link

fishbowl daemon install
fishbowl daemon doctor
```

The daemon runs only for the current user. No administrator account is required.

### Register a Project

```bash
cd /absolute/path/to/your-project
fishbowl project register \
  --root "$PWD" \
  --name "My Project" \
  --description "Local engineering knowledge"
```

Copy the returned project ID and use it in the normal loop:

```bash
fishbowl query --project "<project-id>" "export failure"
fishbowl checkpoint \
  --project "<project-id>" \
  --task "Fix export failure" \
  --outcome succeeded \
  --summary "Moved composition work off the main actor and passed focused verification."
```

## Give Fishbowl to Codex or Another Agent

Configure the user-level stdio MCP server once, then copy the [MCP Agent Session Prompt](docs/agent-bootstrap-prompt.md) into a coding agent. It tells the agent to:

1. Call Fishbowl MCP tools directly for project resolution and preflight.
2. Query relevant history before substantive work.
3. Save concise, redacted checkpoints through MCP when the task ends.
4. Report an unavailable MCP server instead of falling back to the CLI.

The MCP client starts this persistent stdio bridge from its server configuration:

```bash
node /absolute/path/to/fishbowl/dist/cli/main.js mcp --stdio
```

See the ready-to-copy [MCP client configurations](docs/mcp-client-configuration.md). Codex must not launch this command itself or use CLI query/write commands. The configured MCP host owns the process and its stdout protocol frames.

## The Engineering Loop

```text
Preflight -> Query prior knowledge -> Implement -> Verify -> Record a redacted checkpoint
```

Fishbowl keeps records distinct so the graph remains useful under review:

| Record | Meaning |
| --- | --- |
| Problem | The decision, incident, or task being investigated |
| Attempt | A concrete approach and its observed outcome |
| Root Cause | An evidenced causal explanation, not a guess |
| Solution | The adopted change, scope, and limitations |
| Verification | The build, test, measurement, or human review that supports it |

## Local-First by Design

```text
CLI / MCP client
       |
       v
Fishbowl daemon (current user, authenticated)
       |
       +-- SQLite knowledge store
       +-- bounded raw command-log references
       +-- Trace Bench on 127.0.0.1 only
```

- No account, hosted service, cloud sync, or telemetry is required.
- Durable graph text is recursively secret-redacted and bounded.
- Raw command logs remain local, retention-bounded, and excluded from graph exports.
- Existing repositories are never modified merely by being registered.

Read [SECURITY.md](SECURITY.md) before sharing any data directory or raw log collection.

## Upgrade from Engineering Knowledge Graph

The first Fishbowl launch migrates the legacy local database, WAL files, token, and raw logs into the Fishbowl data directory. Existing graph exports remain import-compatible; newly created exports use the `fishbowl` format marker.

Run once after upgrading:

```bash
fishbowl daemon install
```

### Updating on Windows (PowerShell)

Run this in the Fishbowl repository you originally cloned. If `git status --short` shows your own changes, commit or stash them before updating:

The source build requires Node.js 22 or newer, Git, Rust stable with the MSVC toolchain, and the Visual Studio Build Tools C++ workload.

```powershell
Set-Location C:\path\to\fishbowl
git status --short
git pull --ff-only origin main
npm ci
npm run build
npm link

fishbowl daemon install
```

`daemon install` stops the previous current-user process and refreshes the `HKCU` startup registration while preserving knowledge under `%LOCALAPPDATA%\Fishbowl`. Fully quit and restart the MCP client (for example Codex or Claude Desktop) afterward so it launches the rebuilt stdio MCP process and starts the daemon when needed. You can then run `fishbowl daemon doctor` yourself in PowerShell to verify it. Agents do not need—and must not try—to locate or run the Fishbowl CLI themselves.

If the MCP client already points to the absolute `dist\cli\main.js` path in the same clone, its configuration does not change. If the clone moved, update it once using [Windows MCP paths](docs/mcp-client-configuration.md#windows-paths).

## Development

```bash
npm install
npm run typecheck
npm test
cargo test --workspace
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow and [docs/](docs/) for architecture, protocol, migration, and recovery notes.
