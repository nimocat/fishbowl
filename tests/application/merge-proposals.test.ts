import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { KnowledgeService } from '../../src/application/knowledge-service.js'
import { closeDatabase, openDatabase } from '../../src/storage/database.js'

describe('relevance feedback and explicit Case merge proposals', () => {
  it('stores only a context digest and never auto-merges similar Cases', () => {
    const root = mkdtempSync(join(tmpdir(), 'ekg-merge-'))
    const projectRoot = join(root, 'project')
    mkdirSync(projectRoot)
    const database = openDatabase(join(root, 'knowledge.db'))
    try {
      const service = new KnowledgeService(database)
      const project = service.registerProject({ name: 'Merge', root: projectRoot })
      const first = service.recordProblem({ project: { projectId: project.id }, caseTitle: 'CoreML Metal device compile failure', data: { summary: 'CoreML Metal device compile failure' } })
      const second = service.recordProblem({ project: { projectId: project.id }, caseTitle: 'CoreML Metal device compilation failure', data: { summary: 'CoreML Metal device compilation failure' } })
      service.reportRelevance({ project: { projectId: project.id }, caseId: first.caseId, contextDigest: 'a'.repeat(64), useful: false })
      const proposals = service.suggestCaseMerges({ project: { projectId: project.id }, limit: 10 })

      expect(proposals).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'proposed' })]))
      expect(service.getCase({ project: { projectId: project.id }, caseId: first.caseId }).status).not.toBe('retired')
      const applied = service.applyCaseMerge({ project: { projectId: project.id }, proposalId: proposals[0]!.id, operationId: 'merge-1' })
      expect(applied.status).toBe('applied')
      expect([first.caseId, second.caseId]).toContain(applied.sourceCaseId)
      expect(service.getCase({ project: { projectId: project.id }, caseId: applied.sourceCaseId }).status).toBe('retired')
      const stored = database.prepare('SELECT context_digest FROM relevance_feedback').get() as { context_digest: string }
      expect(stored.context_digest).toBe('a'.repeat(64))
    } finally {
      closeDatabase(database)
      rmSync(root, { recursive: true, force: true })
    }
  })
})
