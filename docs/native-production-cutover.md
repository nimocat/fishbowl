# Native Rust EKG Production Cutover Runbook

## Scope and authorization

This runbook changes the current-user EKG installation and its active writer.
Do not execute the production steps until the user explicitly approves the
cutover. Dry-run checks and isolated database copies do not grant that
approval.

Candidate source:

```text
/Users/eric/yqshunjian-ios-codex/.worktrees/ekg-efficiency-rounds
branch: codex/ekg-efficiency-rounds
minimum accepted commit: f913f0d
```

Installed source:

```text
/Users/eric/engineering-knowledge-graph
branch: main
pre-cutover commit: a6d8fbd
```

The branch is a pure fast-forward from `main`. Preserve unrelated untracked
files in the installed source tree.

## Authoritative database selection

The complete source database is:

```text
/Users/eric/.engineering-knowledge-graph/data/knowledge.db
```

The current platform-default database is:

```text
/Users/eric/Library/Application Support/EKG/knowledge.db
```

The source database has 1,262 events, 80 Cases, and 442 nodes. The current
default has 801 events, 59 Cases, and 288 nodes. A read-only `EXCEPT` audit of
all 18 non-rebuildable business tables found zero default rows missing from
the source. Therefore the source is the strict superset and is the only valid
cutover input. Re-run this audit immediately after writer quiescence.

An isolated rollback rehearsal copied the source with SQLite backup, wrote one
checkpoint through the candidate Rust daemon, stopped that daemon, then read
the Rust-written Attempt and ran integrity through the pre-cutover TypeScript
CLI. The final immutable check returned `ok`, 445 nodes, and 1,271 events.
Explicit `--data-dir` selects the old CLI's embedded recovery path, so that
part of the rehearsal intentionally creates no second daemon PID.

## Pre-cutover gates

1. Candidate worktree is clean at the accepted commit.
2. `main...candidate` remains `0 N`; merge is fast-forward only.
3. Rust workspace tests, TypeScript adapter tests, build, architecture boundary,
   fixed native benchmark, `git diff --check`, and secret scan pass.
4. Candidate native `integrity` passes on a fresh SQLite backup of the source.
5. Capture the LaunchAgent process, descriptor process, listener ports, and
   every process holding either database. More than one old daemon is possible;
   stopping only the descriptor PID is insufficient.
6. Record the source/default counts and the full-table containment result.
7. Run npm packaging with an explicitly private writable cache. The default
   user npm cache currently contains root-owned entries and returns `EPERM`;
   changing ownership is not part of this cutover.

## Atomic cutover

Use one timestamp for every artifact.

1. Create a rollback branch at the pre-cutover `main` commit. Do not reset or
   rewrite `main`.
2. Boot out `io.ekg.daemon`, terminate any remaining EKG daemon process whose
   executable resolves to the installed EKG package, and wait until `lsof`
   reports no holder of either database.
3. Run WAL checkpoints where possible, then create SQLite `.backup` files for
   both the default and source databases in a private timestamped backup
   directory. Hash both backups and set directory/file permissions to 0700/0600.
4. Re-run the strict-superset audit against the quiesced backups. Abort if any
   default business row is absent from the source backup.
5. Fast-forward installed `main` to `codex/ekg-efficiency-rounds`; run clean
   dependency installation and `npm run build`. Confirm the packaged native
   binary is executable and the architecture boundary remains green.
6. Restore the complete source backup to a new staged database path under the
   default directory. Run native `integrity` against the staged path. Never
   overwrite the live path in place.
7. Move the old default database and any WAL/SHM files into the timestamped
   backup directory, then atomically rename the staged database to
   `knowledge.db` and enforce mode 0600.
8. Run `ekg daemon install` from the new built CLI. Inspect the plist and require
   `ProgramArguments[0]` to be the packaged `dist/native/ekg-rust-core`, not
   Node, a worktree `target/` path, or an environment-dependent wrapper.
9. Require one native daemon process, one descriptor PID, one loopback listener,
   and a descriptor whose PID matches the listener owner.

Abort before step 6 if code installation fails. After step 6, use the rollback
procedure rather than attempting an in-place repair.

## Installed acceptance

Against the real installed CLI and default data directory:

1. `project list` returns project `fafff939-4e7a-42da-afc7-5782dde8947a` and
   the known worktree aliases.
2. A real project Preflight returns bounded project-local guidance.
3. A query returns Case `087bb44e-24ac-4a75-a49b-3a7f74935f89`.
4. A uniquely keyed checkpoint writes once; replay returns the same result and
   does not increase node/event counts.
5. Trace Bench projects, graph, Case, activity, static page, and SSE endpoints
   respond on loopback with the expected security headers.
6. `integrity` returns `quick_check: ok`; business counts are at least the
   quiesced source counts plus the one acceptance checkpoint.
7. Fixed native benchmark remains within the committed budgets.
8. No Node daemon holds the database, and no TypeScript SQLite dependency is
   present in the installed package.

Keep the migration Case candidate until the user confirms the installed
experience. Only then record human verification, close the Case, and mark the
project goal complete.

## Rollback

1. Boot out the native LaunchAgent and verify no process holds the database.
2. Move the failed post-cutover database intact into the backup directory; do
   not delete it.
3. Restore the pre-cutover default SQLite backup atomically, including mode
   0600. This intentionally discards cutover-only writes from the active store
   while retaining them in the failed database artifact.
4. Switch the installed worktree to the preserved rollback branch, reinstall
   its locked dependencies, rebuild it, and run its daemon installation.
   Do not reset `main` or delete the Rust branch.
5. Verify old CLI project list, query, checkpoint replay, and Trace Bench on the
   restored database.
6. Record the failed cutover Attempt and retained artifact digests in EKG before
   any second cutover attempt.

Rollback never points the old writer at a database after an unreviewed schema
upgrade. It restores the exact pre-cutover database backup and retains every
post-cutover byte separately for diagnosis.
