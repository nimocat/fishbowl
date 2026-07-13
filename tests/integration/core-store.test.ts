import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  CaseGraph,
  CaseNotFoundError,
  EventJournal,
  ProjectRegistry,
  closeDatabase,
  openDatabase,
} from '../../src/index.js'

describe('core knowledge store', () => {
  const sandboxes: string[] = []

  afterEach(() => {
    for (const sandbox of sandboxes.splice(0)) {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it('keeps two project graphs and their event streams isolated', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'ekg-integration-'))
    sandboxes.push(sandbox)
    const rootA = join(sandbox, 'a')
    const rootB = join(sandbox, 'b')
    mkdirSync(rootA)
    mkdirSync(rootB)

    const database = openDatabase(':memory:')
    const registry = new ProjectRegistry(database)
    const graph = new CaseGraph(database)
    const journal = new EventJournal(database)

    try {
      const projectA = registry.register({ name: 'A', root: rootA })
      const projectB = registry.register({ name: 'B', root: rootB })
      const caseA = graph.createCase(projectA.id, 'Compiler failure')
      graph.addNode(caseA.id, {
        type: 'Problem',
        status: 'open',
        data: { summary: 'failure' },
      })

      expect(graph.getCase(projectA.id, caseA.id).nodes).toHaveLength(1)
      expect(() => graph.getCase(projectB.id, caseA.id)).toThrow(
        CaseNotFoundError,
      )
      expect(
        journal
          .listAfter(0, projectB.id)
          .every((event) => event.projectId === projectB.id),
      ).toBe(true)
      expect(journal.listAfter(0, projectB.id).map((event) => event.type)).toEqual([
        'project.registered',
      ])
    } finally {
      closeDatabase(database)
    }
  })
})
