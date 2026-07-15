import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import { KnowledgeService } from '../../src/application/knowledge-service.js'
import type { FinalizeWorkInput } from '../../src/application/contracts.js'
import { closeDatabase, openDatabase } from '../../src/storage/database.js'

describe('KnowledgeService.finalizeWork', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => cleanup.splice(0).forEach((close) => close()))

  function harness(name = 'Finalize') {
    const root = mkdtempSync(join(tmpdir(), 'ekg-finalize-work-'))
    const projectRoot = join(root, 'project')
    mkdirSync(projectRoot)
    const database = openDatabase(join(root, 'knowledge.db'))
    cleanup.push(() => { closeDatabase(database); rmSync(root, { recursive: true, force: true }) })
    const service = new KnowledgeService(database)
    const project = service.registerProject({ name, root: projectRoot })
    return { database, service, project }
  }

  function input(projectId: string, overrides: Partial<FinalizeWorkInput> = {}): FinalizeWorkInput {
    return {
      project: { projectId }, operationId: 'finalize-1', task: 'Fix device compile',
      outcome: 'succeeded', summary: 'schema-v1 passed on device', files: ['S1Pro.swift'],
      commit: { sha: 'abc1234', message: 'fix: keep schema v1', branch: 'feature/s1' },
      failedAttempts: [{
        hypothesis: 'schema-v2 is supported', change: 'Enabled schema-v2',
        failureExplanation: 'Device compile rejected schema-v2', command: ['xcodebuild', 'test'],
      }],
      rootCause: { explanation: 'schema-v2 unsupported', confidence: 0.95, evidence: ['device compiler output'] },
      solution: { summary: 'Keep schema-v1', applicability: ['S1 Pro'], limitations: ['No schema-v2'], decisiveDifference: 'Restored schema-v1' },
      verifications: [
        { kind: 'automated', succeeded: true, command: ['xcodebuild', 'test'], excerpt: 'tests passed' },
        { kind: 'device', succeeded: true, excerpt: 'iPhone passed', environment: { destination: 'iPhone 17 Pro' } },
      ],
      merge: { status: 'merged', sourceBranch: 'feature/s1', targetBranch: 'main', mergeCommit: 'def5678' },
      ...overrides,
    }
  }

  it('records the complete delivery graph and bounded Git facts', () => {
    const { database, service, project } = harness()
    const result = service.finalizeWork(input(project.id))

    expect(result).toMatchObject({
      recorded: true, createdCase: true, attemptIds: [expect.any(String), expect.any(String)],
      verificationIds: [expect.any(String), expect.any(String)],
      artifactIds: [expect.any(String), expect.any(String)], mergeRecorded: true,
      promotion: { status: 'candidate' },
    })
    const detail = service.getCase({ project: { projectId: project.id }, caseId: result.caseId, detail: 'full' })
    expect(detail.nodes.map((node) => node.type)).toEqual([
      'Problem', 'Attempt', 'Attempt', 'RootCause', 'Solution', 'Verification', 'Verification', 'Artifact', 'Artifact',
    ])
    expect(detail.edges.filter((edge) => edge.relation === 'PRECEDED_BY')).toHaveLength(1)
    expect(detail.artifacts.map((artifact) => artifact.uri).sort()).toEqual([
      'git:commit:abc1234', 'git:merge:def5678',
    ])
    expect(JSON.stringify(detail.artifacts)).not.toContain('raw')
    expect((database.prepare('SELECT count(*) AS count FROM cases').get() as { count: number }).count).toBe(1)
  })

  it('replays atomically without duplicate rows', () => {
    const { database, service, project } = harness()
    const request = input(project.id)
    const first = service.finalizeWork(request)
    const before = database.prepare('SELECT count(*) AS count FROM nodes').get() as { count: number }
    expect(service.finalizeWork(request)).toEqual(first)
    expect(database.prepare('SELECT count(*) AS count FROM nodes').get()).toEqual(before)
  })

  it('validates the complete request before creating a Case', () => {
    const { database, service, project } = harness()
    expect(() => service.finalizeWork(input(project.id, {
      verifications: [
        { kind: 'automated', succeeded: true, command: ['npm', 'test'], excerpt: 'pass' },
        { kind: 'device', succeeded: true, excerpt: 'missing destination' },
      ],
    }))).toThrow(/destination/i)
    expect(database.prepare('SELECT count(*) AS count FROM cases').get()).toEqual({ count: 0 })
  })

  it('enforces project ownership for an explicit Case', () => {
    const { database, service, project } = harness()
    const otherRoot = join(tmpdir(), `ekg-other-${Date.now()}`)
    mkdirSync(otherRoot)
    cleanup.push(() => rmSync(otherRoot, { recursive: true, force: true }))
    const other = service.registerProject({ name: 'Other', root: otherRoot })
    const existing = service.recordProblem({
      project: { projectId: project.id }, caseTitle: 'Existing', data: { summary: 'Existing' },
    })
    expect(() => service.finalizeWork(input(other.id, { caseId: existing.caseId })))
      .toThrow(/not found/i)
    expect((database.prepare('SELECT count(*) AS count FROM cases').get() as { count: number }).count).toBe(1)
  })

  it('reuses only an exact fingerprint when caseId is absent', () => {
    const { service, project } = harness()
    const first = service.finalizeWork(input(project.id, { operationId: 'first', fingerprint: 'Metal / schema-v1' }))
    const exact = service.finalizeWork(input(project.id, { operationId: 'exact', fingerprint: '  Metal / schema-v1  ' }))
    const similar = service.finalizeWork(input(project.id, { operationId: 'similar', fingerprint: undefined, task: 'Fix device compilation' }))
    expect(exact.caseId).toBe(first.caseId)
    expect(exact.createdCase).toBe(false)
    expect(similar.caseId).not.toBe(first.caseId)
  })
})
