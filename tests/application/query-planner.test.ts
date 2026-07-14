import { afterEach, describe, expect, it } from 'vitest'

import {
  buildFtsQuery,
  matchingCaseIds,
  matchingFingerprintCaseIds,
} from '../../src/application/query-planner.js'
import { closeDatabase, openDatabase } from '../../src/storage/database.js'

describe('knowledge query planner', () => {
  const databases: ReturnType<typeof openDatabase>[] = []

  afterEach(() => {
    for (const database of databases.splice(0)) closeDatabase(database)
  })

  it('builds safe Unicode prefix expressions and rejects token-empty input', () => {
    expect(buildFtsQuery('AVFoundation streaming'))
      .toBe('"AVFoundation"* AND "streaming"*')
    expect(buildFtsQuery('" OR *')).toBeNull()
    expect(buildFtsQuery('羽球 算法')).toBe('"羽球"* AND "算法"*')
  })

  it('uses the FTS index while preserving explicit project scope', () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    const now = '2026-07-14T00:00:00.000Z'
    database.prepare('INSERT INTO projects VALUES (?, ?, NULL, ?, ?)').run('a', 'A', '/a', now)
    database.prepare('INSERT INTO projects VALUES (?, ?, NULL, ?, ?)').run('b', 'B', '/b', now)
    database.prepare('INSERT INTO cases VALUES (?, ?, ?, ?, ?)').run('case-a', 'a', 'A', 'open', now)
    database.prepare('INSERT INTO cases VALUES (?, ?, ?, ?, ?)').run('case-b', 'b', 'B', 'open', now)
    database.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?)').run(
      'node-a', 'case-a', 'Problem', 'open', '{"summary":"AVFoundation streaming"}', now,
    )
    database.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?)').run(
      'node-b', 'case-b', 'Problem', 'open', '{"summary":"AVFoundation streaming"}', now,
    )
    database.prepare('INSERT INTO node_search VALUES (?, ?, ?, ?)').run(
      'a', 'node-a', 'A', '{"summary":"AVFoundation streaming"}',
    )
    database.prepare('INSERT INTO node_search VALUES (?, ?, ?, ?)').run(
      'b', 'node-b', 'B', '{"summary":"AVFoundation streaming"}',
    )
    database.prepare('INSERT INTO fingerprints VALUES (?, ?, ?, ?, ?, ?)').run(
      'fingerprint-a', 'a', 'node-a', 'normalized-v1', 'stable-fingerprint', now,
    )
    database.prepare('INSERT INTO fingerprints VALUES (?, ?, ?, ?, ?, ?)').run(
      'fingerprint-b', 'b', 'node-b', 'normalized-v1', 'stable-fingerprint', now,
    )

    expect(matchingCaseIds(database, 'a', 'AVFoundation streaming', 25)).toEqual(['case-a'])
    expect(matchingFingerprintCaseIds(database, 'a', 'stable-fingerprint')).toEqual(['case-a'])
    const plan = database.prepare(
      `EXPLAIN QUERY PLAN
       SELECT nodes.case_id
       FROM node_search
       JOIN nodes ON nodes.id = node_search.node_id
       JOIN cases ON cases.id = nodes.case_id
       WHERE node_search MATCH ? AND cases.project_id = ?
       LIMIT ?`,
    ).all(buildFtsQuery('AVFoundation streaming'), 'a', 25) as Array<{ detail: string }>
    expect(plan.map((row) => row.detail).join('\n')).toMatch(/VIRTUAL TABLE INDEX .*M/i)
  })
})
