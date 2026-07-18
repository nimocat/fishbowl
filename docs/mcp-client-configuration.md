# MCP Client Configuration

Build Fishbowl before configuring a client:

```bash
cd /Users/eric/fishbowl
npm install
npm run build
npm link
fishbowl daemon install
```

Every example starts a thin local stdio process that authenticates to the persistent daemon:

```text
node /Users/eric/fishbowl/dist/cli/main.js mcp --stdio
```

The client must keep stdin/stdout attached for MCP protocol traffic. Fishbowl does not print startup diagnostics to stdout.

## Windows Paths

After building Fishbowl, resolve the exact Windows paths from PowerShell:

```powershell
Set-Location C:\path\to\fishbowl
$nodePath = (Get-Command node).Source
$mcpEntry = (Resolve-Path .\dist\cli\main.js).Path
$nodePath
$mcpEntry
```

Use the two printed absolute paths in the MCP client configuration. JSON requires doubled backslashes:

```json
{
  "mcpServers": {
    "fishbowl": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\src\\fishbowl\\dist\\cli\\main.js",
        "mcp",
        "--stdio"
      ]
    }
  }
}
```

For Codex TOML on Windows, single-quoted literal strings keep backslashes readable:

```toml
[mcp_servers.fishbowl]
command = 'C:\Program Files\nodejs\node.exe'
args = ['C:\src\fishbowl\dist\cli\main.js', 'mcp', '--stdio']
enabled = true
required = true
startup_timeout_sec = 30
tool_timeout_sec = 60
default_tools_approval_mode = "writes"
```

These commands and paths configure the MCP Host. They are not agent-session fallback commands. After rebuilding or changing either path, fully restart the MCP client and verify that its server list exposes `fishbowl` tools.

## Claude Desktop Style

Add this server under `mcpServers` in the client's JSON configuration, then restart the client:

```json
{
  "mcpServers": {
    "fishbowl": {
      "command": "node",
      "args": [
        "/Users/eric/fishbowl/dist/cli/main.js",
        "mcp",
        "--stdio"
      ]
    }
  }
}
```

## Codex Style

Codex's native configuration is TOML, not JSON. The equivalent `~/.codex/config.toml` entry is:

```toml
[mcp_servers.fishbowl]
command = "/absolute/path/to/node"
args = ["/Users/eric/fishbowl/dist/cli/main.js", "mcp", "--stdio"]
enabled = true
required = true
startup_timeout_sec = 30
tool_timeout_sec = 60
default_tools_approval_mode = "writes"

```

Configure this entry once at user level. During a Codex task, use direct Fishbowl MCP tool calls for project resolution, preflight, queries, and writes. Never fall back to the Fishbowl CLI or launch the stdio command from Codex's shell when an MCP call fails. Report the unavailable server instead; the command above is only the MCP host's process descriptor.

Do not ask Codex to locate Fishbowl with `which`, `where`, `Get-Command`, package scripts, or filesystem search. If the `fishbowl` namespace is absent, fix the user-level MCP configuration outside the task and restart Codex.

The same configuration can be added without editing a file:

```bash
codex mcp add fishbowl -- node /Users/eric/fishbowl/dist/cli/main.js mcp --stdio
```

For a Codex-compatible host that asks for a generic JSON stdio descriptor, use:

```json
{
  "name": "fishbowl",
  "transport": "stdio",
  "command": "node",
  "args": [
    "/Users/eric/fishbowl/dist/cli/main.js",
    "mcp",
    "--stdio"
  ]
}
```

## OpenCode Style

Add this entry to `opencode.json` or `opencode.jsonc`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "fishbowl": {
      "type": "local",
      "command": [
        "node",
        "/Users/eric/fishbowl/dist/cli/main.js",
        "mcp",
        "--stdio"
      ],
      "enabled": true
    }
  }
}
```

## Verify The Connection

Use the client's MCP server list to confirm that `fishbowl` exposes tools such as `get_preflight_guidance`, `checkpoint_work`, `finalize_work`, `get_operation_result`, `get_operation_metrics`, `report_relevance`, and `suggest_case_merges`. Human-operated CLI diagnostics and every MCP client share the daemon-owned database automatically. Configure this server at Codex's user level and do not add `FISHBOWL_DATA_DIR` to user or workspace MCP configuration. An explicit alternate directory is reserved for isolated tests or recovery and must never be allowed to become a second production writer.

The daemon RPC contract is versioned. Protocol generation 2 rejects generation
1 descriptors so a stale installed process cannot silently receive requests
whose operation or response shape has changed.

Use `finalize_work` as the fixed “提交事实＋验证事实＋合并事实” recording template. It never runs Git or validation commands. Its arrays contain strings, its retry key is `operationId`, and device evidence does not become human-confirmed unless the caller explicitly supplies `humanConfirmed: true`. Prefer an explicit `caseId`; without one, only an exact normalized fingerprint may reuse a Case.

If a write response is ambiguous, call `get_operation_result` with the same project, `operationId`, and operation kind before retrying. `get_operation_metrics` also requires an explicit project and is aggregated by the persistent daemon, so project-owned counts survive MCP bridge restarts but reset with the daemon process.

If startup fails, leave the Codex task on MCP-only behavior and perform these human-operated diagnostics outside the agent session:

```bash
node --version
test -f /Users/eric/fishbowl/dist/cli/main.js
fishbowl daemon doctor
fishbowl daemon status
```

Do not point a client at a database reporting corruption or a newer incompatible schema. Follow the recovery procedure in [README.md](../README.md) first.
