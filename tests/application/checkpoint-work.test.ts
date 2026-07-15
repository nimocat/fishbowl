import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { KnowledgeService } from '../../src/application/knowledge-service.js'
import { closeDatabase, openDatabase } from '../../src/storage/database.js'

describe('checkpointWork', () => {
  const cleanup: Array<() => void> = []

  afterEach(() => cleanup.splice(0).forEach((close) => close()))

  function harness() {
    const root = mkdtempSync(join(tmpdir(), 'ekg-checkpoint-work-'))
    const projectRoot = join(root, 'project')
    mkdirSync(projectRoot)
    const database = openDatabase(join(root, 'knowledge.db'))
    cleanup.push(() => { closeDatabase(database); rmSync(root, { recursive: true, force: true }) })
    const service = new KnowledgeService(database)
    const project = service.registerProject({ name: 'Checkpoint', root: projectRoot })
    return { service, project }
  }

  it('captures a failed route concisely and replays without duplicates', () => {
    const { service, project } = harness()
    const input = {
      project: { projectId: project.id },
      operationId: 'checkpoint-1',
      task: 'Fix Metal material flicker',
      outcome: 'failed' as const,
      summary: 'Two-pass Gaussian regressed total latency',
    }
    const first = service.checkpointWork(input)
    const replay = service.checkpointWork(input)

    expect(first).toMatchObject({ recorded: true, createdCase: true })
    expect(replay).toEqual(first)
    const snapshot = service.getCase({ project: input.project, caseId: first.caseId! })
    expect(snapshot.nodes.map((node) => node.type)).toEqual(['Problem', 'Attempt'])
  })

  it('skips routine success but records root cause and solution as candidates', () => {
    const { service, project } = harness()
    expect(service.checkpointWork({
      project: { projectId: project.id }, operationId: 'routine-1', task: 'Rename label',
      outcome: 'succeeded', summary: 'Renamed label', importance: 'routine',
    })).toMatchObject({ recorded: false, reason: 'routine-success' })

    const recorded = service.checkpointWork({
      project: { projectId: project.id }, operationId: 'notable-1', task: 'Fix schema',
      outcome: 'succeeded', summary: 'schema-v1 passed device validation', importance: 'notable',
      evidence: ['device test passed'],
      rootCause: { explanation: 'schema-v2 is unsupported', confidence: 0.9 },
      solution: { summary: 'Keep schema-v1', applicability: ['S1 Pro'], limitations: ['schema-v2 unavailable'], decisiveDifference: 'Restored schema-v1' },
      humanConfirmed: true,
    })
    const snapshot = service.getCase({ project: { projectId: project.id }, caseId: recorded.caseId! })
    expect(snapshot.nodes.find((node) => node.type === 'RootCause')?.status).toBe('candidate')
    expect(snapshot.nodes.find((node) => node.type === 'Solution')?.status).toBe('candidate')
  })
})
