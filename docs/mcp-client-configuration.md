# MCP Client Configuration

Build EKG before configuring a client:

```bash
cd /Users/eric/engineering-knowledge-graph
npm install
npm run build
npm link
ekg daemon install
```

Every example starts a thin local stdio process that authenticates to the persistent daemon:

```text
node /Users/eric/engineering-knowledge-graph/dist/cli/main.js mcp --stdio
```

The client must keep stdin/stdout attached for MCP protocol traffic. EKG does not print startup diagnostics to stdout.

## Claude Desktop Style

Add this server under `mcpServers` in the client's JSON configuration, then restart the client:

```json
{
  "mcpServers": {
    "engineering-knowledge-graph": {
      "command": "node",
      "args": [
        "/Users/eric/engineering-knowledge-graph/dist/cli/main.js",
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
[mcp_servers.engineering-knowledge-graph]
command = "node"
args = ["/Users/eric/engineering-knowledge-graph/dist/cli/main.js", "mcp", "--stdio"]

```

The same configuration can be added without editing a file:

```bash
codex mcp add engineering-knowledge-graph -- node /Users/eric/engineering-knowledge-graph/dist/cli/main.js mcp --stdio
```

For a Codex-compatible host that asks for a generic JSON stdio descriptor, use:

```json
{
  "name": "engineering-knowledge-graph",
  "transport": "stdio",
  "command": "node",
  "args": [
    "/Users/eric/engineering-knowledge-graph/dist/cli/main.js",
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
    "engineering-knowledge-graph": {
      "type": "local",
      "command": [
        "node",
        "/Users/eric/engineering-knowledge-graph/dist/cli/main.js",
        "mcp",
        "--stdio"
      ],
      "enabled": true
    }
  }
}
```

## Verify The Connection

Use the client's MCP server list to confirm that `engineering-knowledge-graph` exposes tools such as `get_preflight_guidance`, `checkpoint_work`, `report_relevance`, and `suggest_case_merges`. CLI and every MCP client share the daemon-owned database automatically. Set `EKG_DATA_DIR` only when intentionally selecting a non-default isolated store, and use the identical value for daemon installation/startup.

If startup fails, verify all three directly:

```bash
node --version
test -f /Users/eric/engineering-knowledge-graph/dist/cli/main.js
ekg daemon doctor
ekg daemon status
```

Do not point a client at a database reporting corruption or a newer incompatible schema. Follow the recovery procedure in [README.md](../README.md) first.
