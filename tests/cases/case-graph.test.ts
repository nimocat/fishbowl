import type Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CaseGraph } from '../../src/cases/case-graph.js'
import { CaseNotFoundError, InvalidGraphError } from '../../src/domain/errors.js'
import { ProjectRegistry } from '../../src/projects/project-registry.js'
import { closeDatabase, openDatabase } from '../../src/storage/database.js'

describe('CaseGraph', () => {
  let database: Database.Database
  let graph: CaseGraph
  let registry: ProjectRegistry
  let sandbox: string
  let projectA: ReturnType<ProjectRegistry['register']>
  let projectB: ReturnType<ProjectRegistry['register']>

  beforeEach(() => {
    database = openDatabase(':memory:')
    graph = new CaseGraph(database)
    registry = new ProjectRegistry(database)
    sandbox = mkdtempSync(join(tmpdir(), 'ekg-cases-'))
    const rootA = join(sandbox, 'a')
    const rootB = join(sandbox, 'b')
    mkdirSync(rootA)
    mkdirSync(rootB)
    projectA = registry.register({ name: 'A', root: rootA })
    projectB = registry.register({ name: 'B', root: rootB })
  })

  afterEach(() => {
    closeDatabase(database)
    rmSync(sandbox, { recursive: true, force: true })
  })

  it('persists a Case graph and appends one event for every mutation', () => {
    const caseRecord = graph.createCase(projectA.id, 'Compiler failure')
    const problem = graph.addNode(caseRecord.id, {
      type: 'Problem',
      status: 'open',
      data: { summary: 'Module not found' },
    })
    const attempt = graph.addNode(caseRecord.id, {
      type: 'Attempt',
      status: 'candidate',
      data: { change: 'Regenerate project' },
    })
    const edge = graph.addEdge(caseRecord.id, {
      sourceId: attempt.id,
      relation: 'ATTEMPTS_TO_SOLVE',
      targetId: problem.id,
    })

    expect(graph.getCase(projectA.id, caseRecord.id)).toEqual({
      ...caseRecord,
      nodes: [problem, attempt],
      edges: [edge],
    })
    expect(
      database
        .prepare("SELECT type FROM events WHERE type LIKE 'case.%' OR type LIKE 'node.%' OR type LIKE 'edge.%' ORDER BY sequence")
        .all(),
    ).toEqual([
      { type: 'case.created' },
      { type: 'node.added' },
      { type: 'node.added' },
      { type: 'edge.added' },
    ])
  })

  it('keeps Cases isolated by project', () => {
    const caseRecord = graph.createCase(projectA.id, 'Only A')

    expect(() => graph.getCase(projectB.id, caseRecord.id)).toThrow(
      CaseNotFoundError,
    )
  })

  it('rejects unknown projects without writing a Case or event', () => {
    const before = database.prepare('SELECT count(*) AS count FROM events').get() as {
      count: number
    }

    expect(() => graph.createCase('missing', 'No owner')).toThrow()

    const after = database.prepare('SELECT count(*) AS count FROM events').get() as {
      count: number
    }
    expect(after.count).toBe(before.count)
  })

  it('rejects invalid endpoints, cross-Case edges, and cycles without events', () => {
    const firstCase = graph.createCase(projectA.id, 'First')
    const secondCase = graph.createCase(projectA.id, 'Second')
    const problem = graph.addNode(firstCase.id, {
      type: 'Problem',
      status: 'open',
      data: {},
    })
    const foreignAttempt = graph.addNode(secondCase.id, {
      type: 'Attempt',
      status: 'open',
      data: {},
    })
    const firstSolution = graph.addNode(firstCase.id, {
      type: 'Solution',
      status: 'candidate',
      data: {},
    })
    const secondSolution = graph.addNode(firstCase.id, {
      type: 'Solution',
      status: 'candidate',
      data: {},
    })
    graph.addEdge(firstCase.id, {
      sourceId: firstSolution.id,
      relation: 'SUPERSEDES',
      targetId: secondSolution.id,
    })
    const before = database.prepare('SELECT count(*) AS count FROM events').get() as {
      count: number
    }

    expect(() =>
      graph.addEdge(firstCase.id, {
        sourceId: problem.id,
        relation: 'ATTEMPTS_TO_SOLVE',
        targetId: firstSolution.id,
      }),
    ).toThrow(InvalidGraphError)
    expect(() =>
      graph.addEdge(firstCase.id, {
        sourceId: foreignAttempt.id,
        relation: 'ATTEMPTS_TO_SOLVE',
        targetId: problem.id,
      }),
    ).toThrow(InvalidGraphError)
    expect(() =>
      graph.addEdge(firstCase.id, {
        sourceId: secondSolution.id,
        relation: 'SUPERSEDES',
        targetId: firstSolution.id,
      }),
    ).toThrow(InvalidGraphError)

    const after = database.prepare('SELECT count(*) AS count FROM events').get() as {
      count: number
    }
    expect(after.count).toBe(before.count)
  })
})
