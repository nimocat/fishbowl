# ADR: Persistent disk measurement cache

## Status

Accepted for production validation.

## Context

The task-end disk ledger spent 6.73 seconds walking 250,000 filesystem entries
on the real project. Most known regenerable roots are unchanged between the
start and finish of a task, so repeating every file metadata read wastes time.
The ledger must remain metadata-only, project-scoped, bounded, symlink-safe,
and non-destructive.

## Decision

Schema v9 stores one cache row per discovered artifact root with its byte
estimate, kind, partial-scan state, and project-relative directory modification
stamps. The Rust scanner always rediscovers candidate roots, validates cached
directory stamps, reuses unchanged roots, and fully measures only invalidated
roots. Complete discovery removes cache rows for roots that disappeared.

Cache writes share the disk-observation SQLite transaction. Cache reads are
project-scoped. Absolute paths, file contents, symlinks, and deletion authority
are never persisted. Cache-hit snapshots are marked review-only because an
in-place file rewrite may not modify a parent directory timestamp. Directory
entry creation/removal and atomic replacement do invalidate the affected root.

## Consequences

- Hot scans perform directory validation instead of reading metadata for every
  file.
- Changed roots are isolated and remeasured while unchanged roots remain hits.
- Bounded cold scans can progressively fill missing roots across later scans,
  increasing coverage without raising the 250,000-entry ceiling.
- Cache evidence accelerates attribution but never becomes sole evidence for
  automatic cleanup.
