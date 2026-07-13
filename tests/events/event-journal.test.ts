import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventJournal } from '../../src/events/event-journal.js'
import { closeDatabase, openDatabase } from '../../src/storage/database.js'

describe('EventJournal', () => {
  let database: Database.Database
  let journal: EventJournal

  beforeEach(() => {
    database = openDatabase(':memory:')
    journal = new EventJournal(database)
    const insertProject = database.prepare(
      `INSERT INTO projects (id, name, canonical_root, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    insertProject.run('project-a', 'A', '/tmp/project-a', '2026-07-13T00:00:00.000Z')
    insertProject.run('project-b', 'B', '/tmp/project-b', '2026-07-13T00:00:00.000Z')

    const insertEvent = database.prepare(
      `INSERT INTO events (project_id, type, aggregate_id, payload, occurred_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    insertEvent.run('project-a', 'first', 'a-1', '{"value":1}', '2026-07-13T00:00:01.000Z')
    insertEvent.run('project-b', 'second', 'b-1', '{"value":2}', '2026-07-13T00:00:02.000Z')
  })

  afterEach(() => closeDatabase(database))

  it('reads parsed events after a sequence in ascending order', () => {
    expect(journal.listAfter(0)).toEqual([
      {
        sequence: 1,
        projectId: 'project-a',
        type: 'first',
        aggregateId: 'a-1',
        payload: { value: 1 },
        occurredAt: '2026-07-13T00:00:01.000Z',
      },
      {
        sequence: 2,
        projectId: 'project-b',
        type: 'second',
        aggregateId: 'b-1',
        payload: { value: 2 },
        occurredAt: '2026-07-13T00:00:02.000Z',
      },
    ])
    expect(journal.listAfter(1).map((event) => event.sequence)).toEqual([2])
  })

  it('filters reads by project without leaking other project events', () => {
    expect(journal.listAfter(0, 'project-b').map((event) => event.projectId)).toEqual([
      'project-b',
    ])
  })

  it('rejects updates and deletes to preserve append-only history', () => {
    expect(() =>
      database.prepare("UPDATE events SET type = 'changed'").run(),
    ).toThrow(/append-only/)
    expect(() => database.prepare('DELETE FROM events').run()).toThrow(/append-only/)
  })
})
