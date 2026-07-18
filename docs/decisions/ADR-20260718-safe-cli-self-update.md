# ADR: Safe source-checkout CLI self-update

Date: 2026-07-18
Status: accepted

## Context

Fishbowl is currently installed from a Git checkout and globally linked with
npm. Updating required users to repeat Git, dependency, build, link, daemon,
and health commands manually, especially on Windows. Agents remain MCP-only;
self-update is a human-operated installation boundary.

## Decision

- Add an option-free `fishbowl update` command for macOS and Windows source
  installations.
- Resolve the source root from the installed CLI module. Require a clean
  worktree, the `main` branch, and the official
  `github.com/nimocat/fishbowl` origin.
- Fetch `origin/main`, accept only an ancestor relationship, and update with
  `git merge --ff-only`. Never stash, force, reset, switch branches, or remove
  user files.
- A successful deployment writes the deployed revision into ignored `dist`
  state. Return a true no-op only when both HEAD and that marker equal
  `origin/main`; a prior failed deployment is therefore repairable by rerunning
  the same command.
- Fast-forward and install dependencies before daemon downtime. Back up the
  prior `dist` under ignored `target` state before stopping or unregistering
  the current-user daemon. Then build, link,
  reinstall, start, and require `daemon doctor` to pass.
- Windows explicitly starts the registered daemon once. macOS waits for the
  LaunchAgent with bounded doctor polling and never uses the generic
  connect-or-spawn client path.
- `daemon doctor` performs an authenticated RPC rather than trusting a PID.
  `daemon stop` refuses to signal a PID that does not pass the same probe and
  waits for confirmed process exit before artifact replacement.
- Windows daemon registration never reads or signals the PID in a retained
  descriptor. The asynchronous `daemon install` command first replaces a
  running daemon only after authenticated probe, stop, and confirmed exit;
  updater shutdown uses the same safety contract. A narrow
  probe-to-signal race remains until the native daemon exposes an authenticated
  shutdown RPC.
- Allow up to roughly 2.5 seconds of bounded LaunchAgent readiness polling so
  normal cold startup or database opening does not cause a false rollback.
- Execute fixed argv only. Windows uses `cmd.exe` solely to launch `npm.cmd`;
  no user-provided value enters that command line.
- Preserve the platform data directory. Schema opening remains backup-first.
  On a deployment failure, restore the prior `dist` and daemon when possible,
  retain the old deployment marker, return bounded recovery commands, and do
  not claim success.

## Consequences

Routine source updates become one command while local changes, forks,
non-main branches, and divergent history require deliberate manual handling.
The MCP Host must still be restarted after an update because an existing stdio
Node process has already loaded the previous adapter code.
