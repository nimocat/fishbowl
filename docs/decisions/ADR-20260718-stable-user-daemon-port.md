# ADR-20260718: Stable per-user daemon port

## Status

Accepted

## Context

The native daemon previously received `--port 0` on every start. Operating
system allocation therefore changed the descriptor from one update to the
next, while an already-running MCP bridge retained the old endpoint. The
human-facing `daemon install` command also returned as soon as launchd was
registered, before the replacement daemon had published and authenticated a
new descriptor. A following status or MCP write could consequently observe a
false unavailable state.

## Decision

- Persist one high loopback port per Fishbowl data directory in owner-only
  `daemon.port` state and pass that exact value to all native daemon launches.
- During the first compatible upgrade, adopt the port from the last valid
  protocol-generation-2 descriptor. The fixed-endpoint CLI persists that
  descriptor port before its updater begins daemon shutdown. New installations
  choose one random port from the dynamic/private range and retain it.
- Treat malformed persisted state as an error. If the selected port cannot
  become ready, report the port and configuration path; never silently move to
  a different endpoint.
- Make `daemon install` an authenticated readiness boundary. It polls for a
  descriptor containing the persisted port and verifies an RPC before
  reporting success. Windows explicitly starts the newly registered process;
  macOS waits for launchd.
- Keep MCP Host restart guidance after product updates because endpoint
  stability reconnects transport but cannot hot-reload MCP adapter code or
  schemas.

## Consequences

Once `daemon.port` exists, ordinary daemon restarts and Fishbowl updates retain
the same loopback endpoint and token, allowing an existing bridge to reconnect.
An update launched by a pre-feature CLI cannot execute code it has not yet
installed, so that one transition may allocate the first sticky port after the
old daemon removes its ephemeral descriptor; MCP Hosts already require restart
after a product update to load new schemas. A rollback to that pre-feature
build can likewise return to an ephemeral endpoint. Later updates and rollbacks
between fixed-endpoint builds retain the port. Port conflicts become visible
and require deliberate operator recovery. First-install random selection has a
small collision possibility, but failure is explicit and a fixed-endpoint build
never drifts without the user changing private configuration.

## Alternatives Considered

- A single product-wide hard-coded port was rejected because two local users
  or another application could collide predictably.
- Continuing to use ephemeral ports and teaching every client to watch the
  descriptor was rejected as needless coordination complexity and would not
  help already-running clients that cache connection state.
- Silently selecting a new port on conflict was rejected because it recreates
  the original stale-endpoint failure.
