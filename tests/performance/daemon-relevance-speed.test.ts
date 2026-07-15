import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

import { describe, expect, it } from 'vitest'

import { KnowledgeService } from '../../src/application/knowledge-service.js'
import { closeDatabase, openDatabase } from '../../src/storage/database.js'

describe('warm Preflight performance', () => {
  it('stays bounded and serves cached Case cards below 100ms p95', () => {
    const root = mkdtempSync(join(tmpdir(), 'ekg-relevance-speed-'))
    const projectRoot = join(root, 'project')
    mkdirSync(projectRoot)
    const database = openDatabase(join(root, 'knowledge.db'))
    try {
      const service = new KnowledgeService(database)
      const project = service.registerProject({ name: 'Speed', root: projectRoot })
      for (let index = 0; index < 100; index += 1) {
        service.recordProblem({
          project: { projectId: project.id },
          caseTitle: `Build history ${index}`,
          data: { summary: `Unrelated generic build failure ${index}`, domain: 'build' },
        })
      }
      const input = {
        project: { projectId: project.id },
        taskDescription: 'Fix unrelated generic build failure 42',
        changedFiles: ['Sources/Build.swift'],
      }
      service.preflight(input)
      const durations = Array.from({ length: 100 }, () => {
        const start = performance.now()
        const result = service.preflight(input)
        expect(result.cards.length).toBeLessThanOrEqual(5)
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(12 * 1024)
        return performance.now() - start
      }).sort((left, right) => left - right)
      expect(durations[Math.floor(durations.length * 0.95)]).toBeLessThan(100)
    } finally {
      closeDatabase(database)
      rmSync(root, { recursive: true, force: true })
    }
  })
})
