import { afterEach, describe, expect, it } from 'vitest'

import Database from 'better-sqlite3'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { closeDatabase, openDatabase } from '../../src/storage/database.js'
import { schemaVersion } from '../../src/storage/schema.js'

describe('openDatabase', () => {
  const databases: ReturnType<typeof openDatabase>[] = []
  const sandboxes: string[] = []

  afterEach(() => {
    for (const database of databases.splice(0)) {
      closeDatabase(database)
    }
    for (const sandbox of sandboxes.splice(0)) {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it('enables safety pragmas and creates the core schema', () => {
    const database = openDatabase(':memory:')
    databases.push(database)

    const tableNames = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name)

    expect(database.pragma('journal_mode', { simple: true })).toBe('memory')
    expect(database.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(database.pragma('busy_timeout', { simple: true })).toBe(5_000)
    expect(database.pragma('user_version', { simple: true })).toBe(schemaVersion)
    expect(tableNames).toEqual(
      expect.arrayContaining([
        'projects',
        'project_aliases',
        'cases',
        'nodes',
        'edges',
        'evidence',
        'fingerprints',
        'guardrails',
        'events',
        'command_runs',
        'artifacts',
        'import_previews',
        'import_proposals',
        'source_keys',
        'node_search',
      ]),
    )
    expect(
      database
        .prepare("SELECT name FROM pragma_table_info('import_proposals') ORDER BY cid")
        .all()
        .map((row) => (row as { name: string }).name),
    ).toContain('project_id')
  })

  it('upgrades an existing unversioned database without losing data', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'ekg-schema-'))
    sandboxes.push(sandbox)
    const path = join(sandbox, 'knowledge.db')
    const legacy = new Database(path)
    legacy.exec(
      'CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, canonical_root TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL) STRICT',
    )
    legacy
      .prepare(
        'INSERT INTO projects (id, name, canonical_root, created_at) VALUES (?, ?, ?, ?)',
      )
      .run('project-1', 'Existing', '/tmp/existing', '2026-07-13T00:00:00.000Z')
    legacy.close()

    const database = openDatabase(path)
    databases.push(database)

    expect(database.pragma('user_version', { simple: true })).toBe(schemaVersion)
    expect(database.prepare('SELECT name FROM projects WHERE id = ?').get('project-1')).toEqual({
      name: 'Existing',
    })
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'command_runs'")
        .get(),
    ).toEqual({ name: 'command_runs' })
  })

  it('marks new EKG databases and applies private data and database permissions', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'ekg-permissions-'))
    sandboxes.push(sandbox)
    const data = join(sandbox, 'private-data')
    const path = join(data, 'knowledge.db')
    const database = openDatabase(path)
    databases.push(database)
    database.exec('CREATE TABLE permission_probe (value TEXT)')
    database.prepare('INSERT INTO permission_probe VALUES (?)').run('write WAL')

    expect(database.pragma('application_id', { simple: true })).toBe(0x454b4701)
    expect(statSync(data).mode & 0o777).toBe(0o700)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
      expect(statSync(sidecar).mode & 0o777).toBe(0o600)
    }
  })

  it('rejects cross-project evidence ownership at the database boundary', () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    const now = new Date().toISOString()
    database.prepare('INSERT INTO projects VALUES (?, ?, NULL, ?, ?)').run('a', 'A', '/a', now)
    database.prepare('INSERT INTO projects VALUES (?, ?, NULL, ?, ?)').run('b', 'B', '/b', now)
    database.prepare('INSERT INTO cases VALUES (?, ?, ?, ?, ?)').run('case-a', 'a', 'A', 'open', now)
    database.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?)').run('node-a', 'case-a', 'Verification', 'open', '{"kind":"human","succeeded":false}', now)

    expect(() => database.prepare('INSERT INTO evidence VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)')
      .run('evidence-b', 'b', 'node-a', 'human', '{}', now)).toThrow(/ownership/i)
  })

  it('refuses to open a database created by a newer schema', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'ekg-schema-'))
    sandboxes.push(sandbox)
    const path = join(sandbox, 'knowledge.db')
    const newer = new Database(path)
    newer.pragma(`user_version = ${schemaVersion + 1}`)
    newer.close()

    const before = readFileSync(path)

    expect(() => openDatabase(path)).toThrow(/read-only recovery mode.*newer schema.*backup/i)
    expect(readFileSync(path)).toEqual(before)
  })

  it('does not replace a corrupt database and reports stable recovery guidance', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'ekg-corrupt-'))
    sandboxes.push(sandbox)
    const path = join(sandbox, 'knowledge.db')
    const corruptBytes = Buffer.from('not a sqlite database; preserve this exact evidence')
    writeFileSync(path, corruptBytes)

    expect(() => openDatabase(path)).toThrow(/read-only recovery mode.*corrupt or unreadable.*backup.*\.recover/is)
    expect(readFileSync(path)).toEqual(corruptBytes)
  })
})
