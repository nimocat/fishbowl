# Rust database migration and recovery

Rust schema opening is backup-first for every existing database below schema
v7. It performs read-only `quick_check` and version inspection before opening a
writable connection. Corrupt and newer databases are never replaced.

Probe a database or a consistent SQLite backup without changing production:

```bash
cargo run -p ekg-storage --example database_probe -- /path/to/knowledge-copy.db
```

The output includes schema version, `quick_check`, and project snapshot counts.
An upgrade backup is named
`knowledge.db.pre-rust-v7-<timestamp>.bak`. To restore it, always choose a new,
nonexistent destination first:

```bash
cargo run -p ekg-storage --example database_probe -- \
  --restore /path/to/knowledge.db.pre-rust-v7-<timestamp>.bak \
  /path/to/recovered/knowledge.db
```

Probe the recovered file, compare project snapshot counts, then stop the daemon
before an operator explicitly swaps files. Never overwrite the original during
recovery. A downgrade uses the same backup with a binary that supports the
backup's `user_version`.
