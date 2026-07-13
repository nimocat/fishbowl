import type Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  KnowledgeService,
  closeDatabase,
  normalizeFingerprint,
  openDatabase,
  startTraceBenchServer,
  type RunningTraceBenchServer,
} from '../../src/index.js'

interface SseEvent {
  id?: number
  event?: string
  data?: Record<string, unknown>
}

describe('first release acceptance', () => {
  let database: Database.Database
  let service: KnowledgeService
  let server: RunningTraceBenchServer
  let sandbox: string
  let rootA: string
  let rootB: string

  beforeEach(async () => {
    sandbox = mkdtempSync(join(tmpdir(), 'ekg-first-release-'))
    rootA = join(sandbox, 'project-a')
    rootB = join(sandbox, 'project-b')
    mkdirSync(rootA)
    mkdirSync(rootB)
    database = openDatabase(join(sandbox, 'knowledge.sqlite'))
    service = new KnowledgeService(database)
    server = await startTraceBenchServer({
      service,
      port: 0,
      sse: { pollIntervalMs: 10, heartbeatIntervalMs: 50, batchSize: 100 },
    })
  })

  afterEach(async () => {
    await server.close()
    closeDatabase(database)
    rmSync(sandbox, { recursive: true, force: true })
  })

  it('accepts the complete troubleshooting, regression, and portable archive journey', async () => {
    const projectA = service.registerProject({ name: 'Project A', root: rootA })
    const projectB = service.registerProject({ name: 'Project B', root: rootB })
    const project = { projectId: projectA.id }
    const fingerprint = `${rootA}/src/generate.ts:91:4 failed at 2026-07-13T20:00:00Z`
    const equivalentFingerprint = `${rootA}/src/generate.ts:12:9 failed at 2026-07-14T09:30:00Z`

    expect(normalizeFingerprint(fingerprint)).toBe(normalizeFingerprint(equivalentFingerprint))
    const problem = service.recordProblem({
      project,
      caseTitle: 'Generated module is missing',
      data: {
        summary: 'Compilation cannot resolve generated output',
        symptoms: ['Build exits 1'],
        domain: 'build',
        fingerprint,
      },
    })
    const firstFailure = service.recordAttempt({
      project,
      caseId: problem.caseId,
      problemId: problem.nodeId,
      data: {
        hypothesis: 'The compiler cache is stale',
        change: 'Cleared the compiler cache',
        outcome: 'failed',
        failureExplanation: 'Generated output remained absent',
      },
    })
    const secondFailure = service.recordAttempt({
      project,
      caseId: problem.caseId,
      problemId: problem.nodeId,
      previousAttemptId: firstFailure.nodeId,
      data: {
        hypothesis: 'Installed dependencies are stale',
        change: 'Reinstalled dependencies',
        outcome: 'failed',
        failureExplanation: 'The generator still did not run',
      },
    })
    const cause = service.recordRootCause({
      project,
      caseId: problem.caseId,
      problemId: problem.nodeId,
      failedAttemptIds: [firstFailure.nodeId, secondFailure.nodeId],
      status: 'verified',
      humanConfirmed: true,
      data: {
        explanation: 'Compilation ran before source generation',
        evidence: ['The build trace contains no generator invocation'],
        confidence: 0.99,
      },
    })
    const solution = service.recordSolution({
      project,
      caseId: problem.caseId,
      rootCauseId: cause.nodeId,
      data: {
        summary: 'Generate sources before compilation',
        applicability: ['Node.js 22 builds'],
        applicabilityBoundary: { runtime: ['node-22'] },
        limitations: ['Requires the generator binary'],
        decisiveDifference: 'Generation now precedes compilation',
        humanVerificationRequired: true,
      },
    })
    const success = service.recordAttempt({
      project,
      caseId: problem.caseId,
      problemId: problem.nodeId,
      previousAttemptId: secondFailure.nodeId,
      data: {
        hypothesis: 'Generation must precede compilation',
        change: 'Inserted generation before the compiler',
        outcome: 'succeeded',
        decisiveDifference: 'Generation now precedes compilation',
      },
    })
    const automated = service.recordVerification({
      project,
      caseId: problem.caseId,
      solutionId: solution.nodeId,
      data: {
        kind: 'automated',
        succeeded: true,
        command: ['npm', 'test'],
        exitStatus: 0,
        excerpt: 'All release checks passed; token=release-secret-sentinel',
      },
    })

    expect(automated.promotion).toEqual({
      status: 'candidate',
      missingRequirements: ['required-human-verification', 'human-confirmation'],
    })

    const human = service.recordVerification({
      project,
      caseId: problem.caseId,
      solutionId: solution.nodeId,
      data: {
        kind: 'human',
        succeeded: true,
        humanConfirmed: true,
        environment: { os: 'darwin' },
        excerpt: 'Generated output reviewed',
      },
    })
    expect(human.promotion).toEqual({ status: 'verified', missingRequirements: [] })
    expect(service.closeCase({ project, caseId: problem.caseId }).promotion).toEqual({
      status: 'verified',
      missingRequirements: [],
    })

    const verifiedCase = service.getCase({ project, caseId: problem.caseId })
    const successCase = verifiedCase.nodes.find((node) => node.type === 'SuccessCase')
    expect(verifiedCase.status).toBe('verified')
    expect(successCase?.status).toBe('verified')
    expect(
      verifiedCase.edges
        .filter((edge) => edge.sourceId === successCase?.id && edge.relation === 'INCLUDES')
        .map((edge) => edge.targetId),
    ).toEqual(expect.arrayContaining([
      problem.nodeId,
      firstFailure.nodeId,
      secondFailure.nodeId,
      success.nodeId,
      cause.nodeId,
      solution.nodeId,
      automated.nodeId,
      human.nodeId,
    ]))

    const guardrail = service.recordGuardrail({
      project,
      caseId: problem.caseId,
      rootCauseId: cause.nodeId,
      status: 'verified',
      data: {
        guidance: 'Run source generation before tests',
        enforcement: 'block',
        criteria: { commandIncludes: ['npm', 'test'] },
      },
    })
    const preflight = service.preflight({
      project,
      taskDescription: 'Run release checks',
      command: ['npm', 'test'],
    })
    expect(preflight.blocked).toBe(true)
    expect(preflight.guardrails).toContainEqual(expect.objectContaining({
      blocks: true,
      node: expect.objectContaining({ id: guardrail.nodeId }),
    }))

    expect(service.queryKnowledge({
      project: { projectId: projectB.id },
      text: 'generated',
    }).items).toEqual([])
    const isolatedGraph = await getJson<{ cases: unknown[] }>(
      `/api/v1/graph?project_id=${projectB.id}`,
    )
    expect(isolatedGraph.cases).toEqual([])

    service.recordCommandResult({
      project,
      caseId: problem.caseId,
      attemptId: success.nodeId,
      command: ['npm', 'test', '--token=release-secret-sentinel'],
      workingDirectory: rootA,
      exitStatus: 0,
      durationMs: 20,
      excerpt: 'passed token=release-secret-sentinel',
      rawLogPath: join(rootA, '.ekg', 'raw-release.log'),
      rawLogDigest: 'sha256:raw-release-log',
      startedAt: '2026-07-13T20:00:00.000Z',
      finishedAt: '2026-07-13T20:00:00.020Z',
    })

    const graph = await getJson<{ asOfSequence: number }>(
      `/api/v1/graph?project_id=${projectA.id}`,
    )
    const stream = await openSse(
      `/api/v1/events?project_id=${projectA.id}&after=${graph.asOfSequence}`,
    )
    const regression = service.markRegression({
      project,
      caseId: problem.caseId,
      solutionId: solution.nodeId,
      fingerprint: equivalentFingerprint,
      observedContext: { runtime: 'node-22' },
    })
    expect(regression.outcome).toBe('regressed')
    const streamedEvents = await stream.takeDataEvents(3)
    stream.close()
    const regressionEvents = streamedEvents.filter(
      (event) => event.data?.type === 'case.regressed',
    )
    expect(new Set(streamedEvents.map((event) => event.id)).size).toBe(streamedEvents.length)
    expect(regressionEvents).toHaveLength(1)
    const regressionEvent = regressionEvents[0]
    expect(regressionEvent).toMatchObject({
      event: 'knowledge_event',
      data: {
        projectId: projectA.id,
        aggregateId: problem.caseId,
        type: 'case.regressed',
      },
    })
    expect(service.listRecentActivity({
      project,
      afterSequence: graph.asOfSequence,
      limit: 20,
    }).events.filter((event) => event.type === 'case.regressed')).toHaveLength(1)

    const regressedCase = service.getCase({ project, caseId: problem.caseId })
    expect(regressedCase.status).toBe('regressed')
    expect(regressedCase.nodes.find((node) => node.id === solution.nodeId)?.status).toBe('regressed')
    expect(regressedCase.nodes.filter((node) => node.type === 'Attempt')).toEqual(
      verifiedCase.nodes.filter((node) => node.type === 'Attempt'),
    )
    expect(regressedCase.evidence).toEqual(verifiedCase.evidence)

    const archive = service.exportProjectGraph({ project })
    const serializedArchive = JSON.stringify(archive)
    expect(serializedArchive).not.toContain('release-secret-sentinel')
    expect(serializedArchive).not.toContain('raw-release.log')
    expect(serializedArchive).not.toContain('rawLog')
    const recursivelyExposedData = {
      events: database.prepare('SELECT payload FROM events WHERE project_id = ?').all(projectA.id),
      search: database.prepare('SELECT title, body FROM node_search WHERE project_id = ?').all(projectA.id),
      serviceSearch: service.queryKnowledge({ project, text: 'release' }),
      http: {
        graph: await getJson(`/api/v1/graph?project_id=${projectA.id}`),
        search: await getJson(`/api/v1/search?project_id=${projectA.id}&q=release`),
        activity: await getJson(`/api/v1/activity?project_id=${projectA.id}&after=0`),
        case: await getJson(`/api/v1/cases/${problem.caseId}?project_id=${projectA.id}`),
      },
      archive,
    }
    expect(JSON.stringify(recursivelyExposedData)).not.toContain('release-secret-sentinel')
    const imported = service.importProjectGraph({
      project: { projectId: projectB.id },
      archive: JSON.parse(serializedArchive),
      operationId: 'first-release-round-trip',
    })
    const importedCase = service.getCase({
      project: { projectId: projectB.id },
      caseId: imported.idMap[problem.caseId] as string,
    })
    expect(imported.created).toMatchObject({
      cases: 1,
      nodes: archive.nodes.length,
      edges: archive.edges.length,
      evidence: archive.evidence.length,
    })
    expect(importedCase.status).toBe('regressed')
    expect(importedCase.nodes).toHaveLength(regressedCase.nodes.length)
    expect(importedCase.edges).toHaveLength(regressedCase.edges.length)
    expect(importedCase.evidence).toHaveLength(regressedCase.evidence.length)
    expect(importedCase.commandRuns).toEqual([])
  })

  async function getJson<T>(path: string): Promise<T> {
    const response = await fetch(`http://127.0.0.1:${server.address.port}${path}`)
    expect(response.status).toBe(200)
    return response.json() as Promise<T>
  }

  function openSse(path: string): Promise<{
    takeDataEvents(count: number): Promise<SseEvent[]>
    close(): void
  }> {
    return new Promise((resolve, reject) => {
      const clientRequest = request({
        hostname: '127.0.0.1',
        port: server.address.port,
        path,
        headers: {
          accept: 'text/event-stream',
          host: `127.0.0.1:${server.address.port}`,
        },
      })
      clientRequest.on('error', reject)
      clientRequest.on('response', (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`SSE returned ${response.statusCode}`))
          response.destroy()
          return
        }
        let buffer = ''
        let waiter: { count: number; resolve(events: SseEvent[]): void } | undefined
        const parsed: SseEvent[] = []
        const flush = () => {
          if (waiter && parsed.length >= waiter.count) {
            const current = waiter
            waiter = undefined
            current.resolve(parsed.splice(0, current.count))
          }
        }
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          buffer += chunk
          let boundary = buffer.indexOf('\n\n')
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const event = parseSseBlock(block)
            if (event?.data) parsed.push(event)
            boundary = buffer.indexOf('\n\n')
          }
          flush()
        })
        resolve({
          takeDataEvents: (count) => new Promise((resolveEvents) => {
            waiter = { count, resolve: resolveEvents }
            flush()
          }),
          close: () => {
            response.destroy()
            clientRequest.destroy()
          },
        })
      })
      clientRequest.end()
    })
  }
})

function parseSseBlock(block: string): SseEvent | undefined {
  if (block.startsWith(':')) return undefined
  const fields = new Map(
    block.split('\n').map((line) => {
      const separator = line.indexOf(':')
      return [line.slice(0, separator), line.slice(separator + 1).trim()] as const
    }),
  )
  const data = fields.get('data')
  return {
    id: fields.has('id') ? Number(fields.get('id')) : undefined,
    event: fields.get('event'),
    data: data ? JSON.parse(data) as Record<string, unknown> : undefined,
  }
}
