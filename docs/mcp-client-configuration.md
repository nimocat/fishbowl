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
required = false
startup_timeout_sec = 30
tool_timeout_sec = 60
default_tools_approval_mode = "writes"

```

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

Use the client's MCP server list to confirm that `fishbowl` exposes tools such as `get_preflight_guidance`, `checkpoint_work`, `finalize_work`, `report_relevance`, and `suggest_case_merges`. CLI and every MCP client share the daemon-owned database automatically. Configure this server at Codex's user level and do not add `FISHBOWL_DATA_DIR` to user or workspace MCP configuration. An explicit alternate directory is reserved for isolated tests or recovery and must never be allowed to become a second production writer.

The daemon RPC contract is versioned. Protocol generation 2 rejects generation
1 descriptors so a stale installed process cannot silently receive requests
whose operation or response shape has changed.

Use `finalize_work` as the fixed “提交事实＋验证事实＋合并事实” recording template. It never runs Git or validation commands. Its arrays contain strings, its retry key is `operationId`, and device evidence does not become human-confirmed unless the caller explicitly supplies `humanConfirmed: true`. Prefer an explicit `caseId`; without one, only an exact normalized fingerprint may reuse a Case.

If startup fails, verify all three directly:

```bash
node --version
test -f /Users/eric/fishbowl/dist/cli/main.js
fishbowl daemon doctor
fishbowl daemon status
```

Do not point a client at a database reporting corruption or a newer incompatible schema. Follow the recovery procedure in [README.md](../README.md) first.
