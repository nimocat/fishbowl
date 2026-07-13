import { afterEach, describe, expect, it } from 'vitest'

import { closeDatabase, openDatabase } from '../../src/storage/database.js'

describe('openDatabase', () => {
  const databases: ReturnType<typeof openDatabase>[] = []

  afterEach(() => {
    for (const database of databases.splice(0)) {
      closeDatabase(database)
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
      ]),
    )
  })
})
