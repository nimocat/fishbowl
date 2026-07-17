# Security Policy

## Supported versions

Security fixes are provided for the latest `main` branch while the project is pre-1.0.

## Reporting a vulnerability

Please do not publish vulnerabilities in a public issue before a fix is available. Use GitHub's private security advisory flow for this repository, or contact the repository owner through GitHub and include a concise, redacted reproduction.

Do not send credentials, personal data, unredacted command logs, or database files.

## Security boundaries

Fishbowl is local-first and single-user. Its HTTP interface binds only to loopback, but raw command logs can contain sensitive output. Keep the Fishbowl data directory private and do not expose its database, logs, or MCP process to untrusted users.
