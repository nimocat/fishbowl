import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { migrateLegacyDatabaseIfNeeded } from '../../src/daemon/migration.js'
import { resolveDaemonPaths } from '../../src/daemon/config.js'
import { closeDatabase, openDatabase } from '../../src/storage/database.js'

describe('legacy data-directory migration', () => {
  const sandboxes: string[] = []

  afterEach(() => sandboxes.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })))

  it('backs up an empty destination and migrates the populated legacy database', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ekg-legacy-home-'))
    sandboxes.push(home)
    const legacyDirectory = join(home, '.engineering-knowledge-graph', 'data')
    mkdirSync(legacyDirectory, { recursive: true })
    const legacyPath = join(legacyDirectory, 'knowledge.db')
    const paths = resolveDaemonPaths({ platform: 'darwin', home, environment: {} })
    const legacy = openDatabase(legacyPath)
    legacy.prepare('INSERT INTO projects (id, name, canonical_root, created_at) VALUES (?, ?, ?, ?)')
      .run('project-1', 'Migrated project', join(home, 'project'), new Date().toISOString())
    closeDatabase(legacy)
    const empty = openDatabase(paths.databasePath)
    closeDatabase(empty)

    const result = await migrateLegacyDatabaseIfNeeded({ paths, home })

    expect(result).toMatchObject({ migrated: true, sourcePath: legacyPath })
    if (!result.migrated) throw new Error('Expected legacy migration')
    expect(result.backupPath).toBeTruthy()
    const migrated = openDatabase(paths.databasePath)
    expect(migrated.prepare('SELECT name FROM projects').get()).toEqual({ name: 'Migrated project' })
    closeDatabase(migrated)
  })

  it('never overwrites a destination that already contains a project', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ekg-populated-home-'))
    sandboxes.push(home)
    const legacyPath = join(home, '.engineering-knowledge-graph', 'data', 'knowledge.db')
    mkdirSync(join(home, '.engineering-knowledge-graph', 'data'), { recursive: true })
    const paths = resolveDaemonPaths({ platform: 'darwin', home, environment: {} })
    for (const [path, id, name] of [[legacyPath, 'legacy', 'Legacy'], [paths.databasePath, 'current', 'Current']] as const) {
      const database = openDatabase(path)
      database.prepare('INSERT INTO projects (id, name, canonical_root, created_at) VALUES (?, ?, ?, ?)')
        .run(id, name, join(home, id), new Date().toISOString())
      closeDatabase(database)
    }

    expect(await migrateLegacyDatabaseIfNeeded({ paths, home })).toEqual({ migrated: false, reason: 'destination-populated' })
    const current = openDatabase(paths.databasePath)
    expect(current.prepare('SELECT name FROM projects').get()).toEqual({ name: 'Current' })
    closeDatabase(current)
  })
})
