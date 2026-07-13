# MCP Client Configuration

Build EKG before configuring a client:

```bash
cd /Users/eric/engineering-knowledge-graph
npm install
npm run build
```

Every example starts the same local stdio process with an absolute built entry-point path and a shared `EKG_DATA_DIR`:

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
      ],
      "env": {
        "EKG_DATA_DIR": "/Users/eric/.engineering-knowledge-graph/data"
      }
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

[mcp_servers.engineering-knowledge-graph.env]
EKG_DATA_DIR = "/Users/eric/.engineering-knowledge-graph/data"
```

The same configuration can be added without editing a file:

```bash
codex mcp add engineering-knowledge-graph --env EKG_DATA_DIR=/Users/eric/.engineering-knowledge-graph/data -- node /Users/eric/engineering-knowledge-graph/dist/cli/main.js mcp --stdio
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
  ],
  "env": {
    "EKG_DATA_DIR": "/Users/eric/.engineering-knowledge-graph/data"
  }
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
      "environment": {
        "EKG_DATA_DIR": "/Users/eric/.engineering-knowledge-graph/data"
      },
      "enabled": true
    }
  }
}
```

## Verify The Connection

Use the client's MCP server list to confirm that `engineering-knowledge-graph` starts and exposes tools such as `register_project`, `list_projects`, `query_knowledge`, and `get_preflight_guidance`. CLI and MCP calls share data only when `EKG_DATA_DIR` resolves to the same absolute directory.

If startup fails, verify all three directly:

```bash
node --version
test -f /Users/eric/engineering-knowledge-graph/dist/cli/main.js
EKG_DATA_DIR=/Users/eric/.engineering-knowledge-graph/data node /Users/eric/engineering-knowledge-graph/dist/cli/main.js integrity
```

Do not point a client at a database reporting corruption or a newer incompatible schema. Follow the recovery procedure in [README.md](../README.md) first.
