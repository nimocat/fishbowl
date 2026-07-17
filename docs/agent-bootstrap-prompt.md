# Agent Bootstrap Prompt

Copy the following prompt into a coding agent that has shell access to your machine. Replace the repository path only when your current directory is not the project root.

```text
Set up and use Fishbowl as the local engineering memory for this repository.

1. If Fishbowl is not installed, clone https://github.com/nimocat/fishbowl.git into a local tools directory, then run:
   npm install
   npm run build
   npm link
   fishbowl daemon install

2. Register the current repository with Fishbowl if it is not registered:
   fishbowl project resolve --root "$PWD"
   If that reports no project, run:
   fishbowl project register --root "$PWD" --name "<repository name>" --description "Local engineering knowledge"

3. At the start of each substantive task, query relevant prior work and record only useful, redacted engineering facts:
   fishbowl query --project "<project-id>" "<task, error, or feature>"

4. Before completing a substantive task, write a concise checkpoint containing the objective, key decision, files changed, verification result, and unresolved risks. Never store secrets, full logs, credentials, user media, or private chat transcripts.

5. Do not expose Fishbowl's local data directory, raw logs, loopback browser, or MCP stdio process to untrusted users.
```

For a persistent MCP integration, use the client-specific configuration in [MCP Client Configuration](mcp-client-configuration.md).
