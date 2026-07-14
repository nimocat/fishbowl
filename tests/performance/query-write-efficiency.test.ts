import type Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { KnowledgeService } from '../../src/application/knowledge-service.js'
import { buildFtsQuery } from '../../src/application/query-planner.js'
import { closeDatabase, openDatabase } from '../../src/storage/database.js'

describe('query and write efficiency regressions', () => {
  let database: Database.Database | undefined
  let sandbox: string | undefined

  afterEach(() => {
    if (database) closeDatabase(database)
    if (sandbox) rmSync(sandbox, { recursive: true, force: true })
    database = undefined
    sandbox = undefined
  })

  it('keeps large Case projections bounded and uses indexed history and search plans', () => {
    database = openDatabase(':memory:')
    sandbox = mkdtempSync(join(tmpdir(), 'ekg-efficiency-'))
    const root = join(sandbox, 'project')
    mkdirSync(root)
    const service = new KnowledgeService(database, { dataRoot: join(sandbox, 'data') })
    const registered = service.registerProject({ name: 'Efficiency fixture', root })
    const project = { projectId: registered.id }
    const problem = service.recordProblem({
      project,
      caseTitle: 'Large streaming fixture',
      data: { summary: 'AVFoundation streaming stalls', domain: 'performance' },
    })
    for (let index = 0; index < 60; index += 1) {
      service.recordAttempt({
        project,
        caseId: problem.caseId,
        problemId: problem.nodeId,
        data: {
          hypothesis: `Bounded probe ${index}`,
          change: 'Measure an indexed candidate',
          outcome: 'failed',
          failureExplanation: 'Synthetic regression fixture',
        },
      })
    }

    const graph = service.getCase({ project, caseId: problem.caseId })
    const fullPage = service.getCase({
      project,
      caseId: problem.caseId,
      detail: 'full',
      historyLimit: 10,
    })
    expect(Buffer.byteLength(JSON.stringify(graph))).toBeLessThan(128 * 1024)
    expect(Buffer.byteLength(JSON.stringify(fullPage))).toBeLessThan(192 * 1024)
    expect(fullPage.history).toHaveLength(10)

    const historyPlan = database.prepare(
      `EXPLAIN QUERY PLAN SELECT * FROM events
       WHERE project_id = ? AND case_id = ? AND sequence < ?
       ORDER BY sequence DESC LIMIT ?`,
    ).all(registered.id, problem.caseId, Number.MAX_SAFE_INTEGER, 11) as Array<{ detail: string }>
    expect(historyPlan.map((row) => row.detail).join('\n'))
      .toMatch(/events_project_case_sequence_idx/)

    const searchPlan = database.prepare(
      `EXPLAIN QUERY PLAN
       SELECT nodes.case_id FROM node_search
       JOIN nodes ON nodes.id = node_search.node_id
       JOIN cases ON cases.id = nodes.case_id
       WHERE node_search MATCH ? AND cases.project_id = ? LIMIT ?`,
    ).all(buildFtsQuery('AVFoundation streaming'), registered.id, 25) as Array<{ detail: string }>
    expect(searchPlan.map((row) => row.detail).join('\n')).toMatch(/VIRTUAL TABLE INDEX .*M/i)

    const prepare = vi.spyOn(database, 'prepare')
    service.queryKnowledge({ project, limit: 5 })
    expect(prepare.mock.calls.map(([sql]) => sql).join('\n')).not.toContain('node_search')
  })
})
