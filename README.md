# Fishbowl

<p align="center">
  <img src="docs/assets/fishbowl-logo.png" width="220" alt="Fishbowl logo: a diving-goggle brain in a fishbowl" />
</p>

<p align="center">
  <strong>Local-first engineering memory for humans and coding agents.</strong><br />
  <a href="README.zh-CN.md">简体中文</a> · <a href="docs/mcp-client-configuration.md">MCP setup</a> · <a href="SECURITY.md">Security</a>
</p>

Fishbowl turns debugging history, failed approaches, evidence, verified fixes, and regressions into a queryable local graph. It provides a CLI, a stdio MCP server, and the loopback-only Trace Bench browser. Registered client repositories are not modified by default.

> Fishbowl is deliberately local-first: no account, cloud sync, telemetry, or hosted service is required.

## Why Fishbowl

Engineering work often repeats the same investigations because the decisive context lives in terminal scrollback, chat sessions, and people’s memory. Fishbowl retains the useful engineering record without treating every note as fact.

- **Preserve failed attempts** so agents and teammates do not repeat them.
- **Separate evidence from conclusions**: attempts, root causes, solutions, and verification have distinct graph types.
- **Keep control local** with SQLite storage, loopback-only browser access, and a stdio MCP bridge.
- **Carry knowledge across worktrees** using canonical project roots and worktree aliases.
- **Keep records reviewable** through append-only project events, bounded redacted graph text, and explicit verification states.

## What It Includes

| Component | Purpose |
| --- | --- |
| `fishbowl` CLI | Register projects, query context, record cases, import/export graphs, and inspect integrity. |
| Persistent daemon | Reuses one authenticated local process, SQLite connection, prepared state, and Trace Bench server. |
| MCP stdio server | Lets compatible coding agents query and checkpoint engineering knowledge. |
| Trace Bench | Read-only local browser for inspecting project knowledge and event activity. |
| Disk observations | Bounded metadata-only tracking of regenerable build artifacts; no automatic deletion. |

## Quick Start

### macOS / Linux

```bash
git clone https://github.com/nimocat/fishbowl.git
cd fishbowl
npm install
npm run build
npm link

fishbowl daemon install
fishbowl daemon status
```

### Windows (PowerShell)

Install Node.js 22 or newer and Git first, then run:

```powershell
git clone https://github.com/nimocat/fishbowl.git
Set-Location fishbowl
npm install
npm run build
npm link

fishbowl daemon install
fishbowl daemon status
```

The Windows daemon is registered for the current user only and Fishbowl stores its local data at `%LOCALAPPDATA%\Fishbowl` by default. No administrator account is required.

To use Fishbowl without `npm link`, replace `fishbowl` in the examples with:

```powershell
node .\dist\cli\main.js
```

### Register a client project

```bash
cd /absolute/path/to/your-project
fishbowl project register --root "$PWD" --name "My Project" --description "Local engineering knowledge"
fishbowl project list
```

Copy the returned project ID, then query prior work or record a compact checkpoint:

```bash
fishbowl query --project "<project-id>" "export failure"
fishbowl checkpoint --project "<project-id>" --task "Fix export failure" --outcome succeeded --summary "Kept composition work off the main actor and verified the focused test suite"
```

## Agent / MCP Setup

Start the stdio MCP bridge with:

```bash
node /absolute/path/to/fishbowl/dist/cli/main.js mcp --stdio
```

It writes protocol frames to stdout, so do not wrap it in commands that print banners. See [MCP client configuration](docs/mcp-client-configuration.md) for ready-to-use client entries.

### Give Fishbowl to an agent in one step

Copy the [Agent Bootstrap Prompt](docs/agent-bootstrap-prompt.md) into a coding agent. It instructs the agent to install Fishbowl, register the current repository, query prior engineering knowledge before substantive work, and save only redacted completion checkpoints.

## Privacy and Security at a Glance

- Project knowledge is stored locally in SQLite.
- The Trace Bench HTTP server binds only to `127.0.0.1`.
- Durable graph records are recursively secret-redacted and bounded.
- Raw command logs are intentionally unredacted, local-only, retention-bounded, and excluded from graph exports.
- Fishbowl is single-user and is not a hosted collaboration service.

Read [SECURITY.md](SECURITY.md) before exposing any part of a Fishbowl data directory or raw log collection.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The project is released under the [MIT License](LICENSE).

## Prerequisites

- Node.js 22 or newer and npm.
- Git for importing an explicit Git commit range.
- Optional: the `sqlite3` CLI for backups and corruption recovery.

## Install And Build

From this repository:

```bash
npm install
npm run build
npm link
```

`npm link` exposes the built `dist/cli/main.js` as `fishbowl`. Re-run `npm run build` after source changes. You can avoid a global link by replacing `fishbowl` below with `node /absolute/path/to/fishbowl/dist/cli/main.js`.

Release verification commands:

```bash
npm run typecheck
npm test
npm run test:acceptance
npx playwright install chromium
npm run test:browser
npm run build
```

This first release does not implement `fishbowl --help`. The commands below are the supported CLI reference.

## Install The Persistent Daemon

Fishbowl now keeps one authenticated loopback daemon alive, so CLI and MCP calls reuse the same Node.js process, SQLite connection, prepared state, relevance cache, and live Trace Bench server.

```bash
fishbowl daemon install
fishbowl daemon status
```

Installation is per-user and needs no administrator access. macOS uses `~/Library/LaunchAgents/io.fishbowl.daemon.plist`; Windows uses `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. Uninstall preserves the database:

```bash
fishbowl daemon uninstall
```

Any normal command starts the daemon once if it is not already ready. `fishbowl daemon status` prints the live Trace Bench `webUrl`; the browser receives updates over SSE as graph events are committed.

## Data Directory

Fishbowl stores its database at `<data-directory>/knowledge.db` and raw command logs under `<data-directory>/logs/<project-id>/`.

Data-directory precedence is:

1. A leading global option: `fishbowl --data-dir /absolute/path <command>`
2. `FISHBOWL_DATA_DIR`
3. macOS: `~/Library/Application Support/Fishbowl`; Windows: `%LOCALAPPDATA%\Fishbowl`; Linux: `${XDG_DATA_HOME:-~/.local/share}/fishbowl`

The data directory is independent of the current client repository. Normal CLI,
MCP, and installed-daemon use must leave `FISHBOWL_DATA_DIR` unset so every client
uses the platform-default store. A leading `--data-dir` or `FISHBOWL_DATA_DIR` is a
recovery/test isolation mechanism, not a second production entry.

```bash
fishbowl integrity

# Isolated recovery only; stop any writer for this directory first.
fishbowl --data-dir "$HOME/fishbowl-recovery" integrity
```

## Client Project Workflow

Run these commands from the client project that owns the knowledge. CLI output is JSON. Copy returned IDs into the shell variables shown below.

### Register The Project

```bash
cd /absolute/path/to/client-project
fishbowl project register --root "$PWD" --name "Client Project" --description "Local engineering knowledge"
fishbowl project list
```

Set `PROJECT_ID` to the returned project `id`:

```bash
export PROJECT_ID="<project-id>"
```

Resolve an already registered project or add a worktree alias:

```bash
fishbowl project resolve --root "$PWD"
fishbowl project update --project "$PROJECT_ID" --add-alias "/absolute/path/to/client-worktree"
```

### Capture A Command

Everything after `--` is passed directly as the child argv without a shell:

```bash
fishbowl run --project "$PROJECT_ID" --task "Run focused tests" --changed-files-json '["src/example.ts"]' -- npm test -- src/example.test.ts
```

Fishbowl streams the child output and normally preserves its exit status. Exit `78` means a verified blocking Guardrail prevented the child from starting; command-not-found is `127`, and a non-executable command is `126`. A post-run knowledge-recording failure is reported as a warning and does not turn a successful child command into a failure.

### Record A Case Manually

Start a Problem and copy the returned `caseId` and `nodeId`:

```bash
fishbowl case start --project "$PROJECT_ID" --title "Generated module is missing" --data-json '{"summary":"Compilation cannot resolve generated output","symptoms":["Build exits 1"],"domain":"build","fingerprint":"compiler cannot resolve generated output"}'
export CASE_ID="<case-id>"
export PROBLEM_ID="<problem-node-id>"
```

Record a failed Attempt and copy its `nodeId`:

```bash
fishbowl case attempt --project "$PROJECT_ID" --case "$CASE_ID" --problem "$PROBLEM_ID" --data-json '{"hypothesis":"The compiler cache is stale","change":"Cleared the cache","outcome":"failed","failureExplanation":"Generated output remained absent"}'
export FAILED_ATTEMPT_ID="<failed-attempt-node-id>"
```

Record an evidenced RootCause and copy its `nodeId`:

```bash
fishbowl case root-cause --project "$PROJECT_ID" --case "$CASE_ID" --problem "$PROBLEM_ID" --failed-attempts-json "[\"$FAILED_ATTEMPT_ID\"]" --status verified --human-confirmed --data-json '{"explanation":"Compilation ran before source generation","evidence":["The build trace has no generator invocation"],"confidence":0.95}'
export ROOT_CAUSE_ID="<root-cause-node-id>"
```

Record a Solution and a successful Attempt, copying the Solution `nodeId`:

```bash
fishbowl case solution --project "$PROJECT_ID" --case "$CASE_ID" --root-cause "$ROOT_CAUSE_ID" --data-json '{"summary":"Generate sources before compilation","applicability":["Node.js 22 builds"],"limitations":["Requires the generator binary"],"decisiveDifference":"Generation now precedes compilation"}'
export SOLUTION_ID="<solution-node-id>"

fishbowl case attempt --project "$PROJECT_ID" --case "$CASE_ID" --problem "$PROBLEM_ID" --previous-attempt "$FAILED_ATTEMPT_ID" --data-json '{"hypothesis":"Generation must precede compilation","change":"Inserted generation before compilation","outcome":"succeeded","decisiveDifference":"Generation now precedes compilation"}'
```

Record automated verification and explicit human confirmation, then close the Case:

```bash
fishbowl case verify --project "$PROJECT_ID" --case "$CASE_ID" --solution "$SOLUTION_ID" --data-json '{"kind":"automated","succeeded":true,"command":["npm","test"],"exitStatus":0,"excerpt":"Focused tests passed"}'
fishbowl case verify --project "$PROJECT_ID" --case "$CASE_ID" --solution "$SOLUTION_ID" --data-json '{"kind":"human","succeeded":true,"humanConfirmed":true,"excerpt":"Reviewed the evidence and confirmed the reusable result"}'
fishbowl case close --project "$PROJECT_ID" --case "$CASE_ID"
```

Promotion always requires a verified evidenced RootCause and a successful human Verification with `"humanConfirmed":true`. Verification `environment` accepts only `os`, `toolVersion`, `architecture`, `scheme`, `destination`, and `configuration`.

### Query And Preflight

```bash
fishbowl query --project "$PROJECT_ID" generated
fishbowl query --project "$PROJECT_ID" --filters-json '{"nodeTypes":["Solution"],"statuses":["verified"],"limit":20}' generation
fishbowl preflight --project "$PROJECT_ID" --task "Change the build pipeline" --command-json '["npm","test"]' --changed-files-json '["package.json"]'
fishbowl activity --project "$PROJECT_ID" --after 0 --limit 50
```

Supported query filter keys are `domain`, `nodeTypes`, `statuses`, `file`, `command`, `fingerprint`, and `limit`.

Preflight returns at most five ranked Case cards by default and keeps its encoded response below 12 KiB. Each card explains why it matched and includes at most one decisive failed Attempt, verified RootCause, and verified Solution. Exact fingerprints, files, commands, and blocking Guardrails outrank generic text. Old candidate conclusions are down-ranked; verified knowledge does not expire because of age alone.

For a concise engineering checkpoint, no long write-array JSON is required:

```bash
fishbowl checkpoint --project "$PROJECT_ID" --task "Fix Metal flicker" --outcome failed --summary "Two-pass Gaussian increased latency"
```

Routine successes may be skipped; failures are always retained. Optional
`--data-json` can add `importance`, `fingerprint`, `files`, `command`,
`evidence`, `rootCause`, and `solution`. `rootCause` and `solution` are typed
objects, not summary strings; invalid shapes are rejected by the CLI before a
daemon request. Supplied roots and solutions remain candidates until the
normal mixed-verification gate is satisfied.

```bash
fishbowl checkpoint --project "$PROJECT_ID" --task "Fix protocol failure" --outcome succeeded --summary "Validated checkpoint locally" --data-json '{"rootCause":{"explanation":"The client sent an obsolete payload shape","confidence":0.99,"rejectedAlternatives":["SQLite corruption"]},"solution":{"summary":"Validate the public checkpoint contract before RPC","applicability":["CLI checkpoint writes"],"limitations":["Does not repair semantically incorrect evidence"],"decisiveDifference":"Malformed writes now fail locally with a field-specific message"}}'
```

### Track Task Disk Growth

Agents can bracket one task with a bounded disk observation. Fishbowl records only sizes and project-relative paths for known regenerable roots; it never reads file contents or follows symlinks:

```bash
fishbowl disk start --project "$PROJECT_ID" --operation "<stable-start-id>" --task "Build feature"
fishbowl disk finish --project "$PROJECT_ID" --operation "<stable-finish-id>" --observation "<observation-id>"
fishbowl disk list --project "$PROJECT_ID" --limit 25
fishbowl disk candidates --project "$PROJECT_ID" --limit 25
```

Cleanup candidates are advisory. Existing directories are marked for review, paths observed during overlapping tasks are marked shared, and no command deletes files automatically. Re-check ownership and request explicit authorization before removing anything.

The first bounded scan populates a project-scoped persistent measurement cache.
Later scans validate directory modification stamps and rescan only changed
artifact roots; `cacheHits` and `cacheMisses` are returned by `disk start` and
`disk finish`. A cache hit is intentionally review-only because an in-place
file rewrite can leave parent-directory timestamps unchanged. Creation,
removal, and atomic replacement invalidate the affected root. Repeated bounded
scans may progressively fill roots that did not fit within an earlier
250,000-entry pass.

### Browse Locally

```bash
fishbowl daemon status
```

Open the printed `webUrl`. Trace Bench is read-only and runs beside the daemon; use CLI or MCP tools for writes. It refreshes from the append-only project event cursor without restarting the browser.

### Preview And Apply An Import

File paths must be absolute, explicit, and inside the registered project. A preview is non-mutating and expires after 24 hours.

```bash
fishbowl import preview --project "$PROJECT_ID" --sources-json '[{"kind":"file","path":"/absolute/path/to/client-project/engineering-notes.md"}]'
export PREVIEW_ID="<preview-id>"
export PROPOSAL_ID="<approved-proposal-id>"

fishbowl import apply --project "$PROJECT_ID" --preview "$PREVIEW_ID" --proposals-json "[\"$PROPOSAL_ID\"]" --operation "apply-notes-20260713"
```

An explicit Git range is also supported:

```bash
fishbowl import preview --project "$PROJECT_ID" --sources-json '[{"kind":"git","range":"main..feature/build-fix"}]'
```

Imported proposals remain candidates until reviewed and verified.

### Export And Import A Project Graph

```bash
fishbowl export --project "$PROJECT_ID" --output "/absolute/path/to/client-project-fishbowl.json"
```

Register or choose an explicit target project, then import the archive with a unique operation ID:

```bash
export TARGET_PROJECT_ID="<target-project-id>"
fishbowl import graph --project "$TARGET_PROJECT_ID" --file "/absolute/path/to/client-project-fishbowl.json" --operation "import-client-project-20260713"
```

Exports are versioned, recursively redacted JSON snapshots. They exclude raw logs, command-run records, and the source project's canonical root.

## MCP Stdio

The MCP stdio process is now a thin proxy to the installed daemon:

```bash
node /absolute/path/to/fishbowl/dist/cli/main.js mcp --stdio
```

The process writes MCP protocol frames to stdout, so do not wrap it with commands that print banners there. See [docs/mcp-client-configuration.md](docs/mcp-client-configuration.md) for client configurations.

Large Case reads are projection-aware: `get_case` accepts `detail` as `summary`, `graph` (the default), or `full`; full history is paged. Agents should prefer `checkpoint_work` for concise capture and use `finalize_work` for a completed delivery containing commit, failed route, root cause, solution, verification, and merge facts. `record_checkpoint` remains available for advanced batches. `report_relevance` stores only a 64-character context digest plus useful/not-useful feedback. `suggest_case_merges` never auto-merges; `apply_case_merge` requires an explicit reviewed proposal and operation ID.

`finalize_work` records facts only. It never executes Git, tests, builds, or device validation:

```json
{
  "project": { "projectRoot": "/absolute/project" },
  "operationId": "delivery-s1-20260715",
  "task": "Keep schema-v1 and validate on device",
  "outcome": "succeeded",
  "summary": "Automated and physical-device checks passed",
  "files": ["S1ProFeatureFrontend.swift"],
  "commit": { "sha": "abc1234", "message": "fix: keep schema v1" },
  "rootCause": { "explanation": "schema-v2 is unsupported", "confidence": 0.95, "evidence": ["device compiler output"] },
  "solution": { "summary": "Keep schema-v1", "applicability": ["S1 Pro"], "limitations": ["schema-v2 unavailable"], "decisiveDifference": "Restored schema-v1" },
  "verifications": [
    { "kind": "automated", "succeeded": true, "command": ["xcodebuild", "test"], "excerpt": "tests passed" },
    { "kind": "device", "succeeded": true, "excerpt": "device passed", "environment": { "destination": "iPhone 17 Pro" } }
  ],
  "merge": { "status": "merged", "targetBranch": "main", "mergeCommit": "def5678" }
}
```

All `files`, `evidence`, applicability, limitation, and command entries are strings. Reuse the same `operationId` when retrying the same delivery. Device evidence is stored as human-kind evidence but is not considered human-confirmed unless `humanConfirmed: true` is supplied explicitly.

## Raw Logs And Retention

`fishbowl run` stores complete, unredacted child stdout and stderr in mode-`0600` files under `logs/<project-id>/`. Defaults are:

- 10 MiB per segment.
- 100 MiB retained per project.
- 30-day maximum age.

Pruning runs when a raw-log session closes. SQLite stores only an 8 KiB bounded redacted excerpt plus raw-log path and SHA-256 metadata. Graph exports never include raw logs. Treat the data directory as sensitive local data and back it up separately if raw evidence matters.

## Security Model

- The first release is local-only and single-user. It has no remote authentication or authorization layer.
- HTTP binds only to `127.0.0.1`, rejects non-loopback Host headers and cross-origin requests, and exposes read-only browser routes.
- MCP runs as a local child process with the launching user's filesystem permissions.
- Imports read only explicitly supplied project-contained files or Git ranges. Disk observations separately perform a bounded metadata-only scan of known regenerable roots when explicitly invoked.
- Durable graph text is recursively secret-redacted and bounded, and environment-variable values are not collected by default. Redaction is defense in depth, not a credential vault.
- Raw logs are intentionally unredacted and may contain secrets printed by child commands.
- Do not expose the HTTP listener, stdio server, data directory, or raw logs to untrusted users.

## Integrity, Backup, And Recovery

Check the active database with SQLite `quick_check`:

```bash
fishbowl integrity
```

The command exits nonzero when the database cannot be safely opened or the check fails. Fishbowl preflights an existing database read-only before writable pragmas or migrations. A corrupt or newer-schema database is not deleted or replaced.

For routine backups, stop Fishbowl writers and preserve the full data directory, including `knowledge.db`, any `knowledge.db-wal` and `knowledge.db-shm` files, and `logs/`. For a healthy online SQLite backup:

```bash
sqlite3 "$FISHBOWL_DATA_DIR/knowledge.db" ".backup '$HOME/fishbowl-backup.db'"
```

If Fishbowl reports a newer schema, make a backup and use the compatible newer Fishbowl build to export each project. Import those JSON archives into the desired installation.

If Fishbowl reports corruption:

1. Stop every Fishbowl CLI, MCP, and browser-server process using that data directory.
2. Copy `knowledge.db` and any WAL/SHM sidecars before attempting repair.
3. Prefer restoring a known-good backup.
4. Otherwise recover from a copy: `sqlite3 damaged-knowledge.db ".recover" > recovered.sql`.
5. Load `recovered.sql` into a separate `knowledge.db` under a separate data directory.
6. Run `fishbowl --data-dir /separate/recovered-data integrity`; if it passes, export projects and import them into a clean data directory.

Never run recovery in place against the only copy.

## Limitations

- No top-level or subcommand `--help` output in the first release.
- Local single-user operation only; no public hosting, remote auth, or multi-user coordination.
- Trace Bench is read-only and graph results are bounded, so large projects may be truncated.
- Events are an immutable audit/change feed, not a complete event-sourcing replay log.
- Imports support selected Markdown/plain-text files, JSON test reports, and explicit Git ranges; they do not infer verified root causes.
- Raw logs are local-only, unredacted, retention-bounded, and excluded from graph exports.
- Export/import transfers durable redacted graph knowledge, not command runs or complete operational state.
