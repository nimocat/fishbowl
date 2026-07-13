import type Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  KnowledgeService,
  closeDatabase,
  openDatabase,
  startTraceBenchServer,
  type RunningTraceBenchServer,
} from '../../src/index.js'

interface ResponseResult {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

interface SseEvent {
  id?: number
  event?: string
  data?: Record<string, unknown>
  comment?: string
}

describe('Trace Bench HTTP server', () => {
  let database: Database.Database
  let service: KnowledgeService
  let running: RunningTraceBenchServer
  let sandbox: string
  let projectA: { id: string }
  let projectB: { id: string }
  let caseA: string

  beforeEach(async () => {
    sandbox = mkdtempSync(join(tmpdir(), 'ekg-http-'))
    const rootA = join(sandbox, 'a')
    const rootB = join(sandbox, 'b')
    mkdirSync(rootA)
    mkdirSync(rootB)
    database = openDatabase(join(sandbox, 'knowledge.sqlite'))
    service = new KnowledgeService(database)
    projectA = service.registerProject({ name: 'Alpha', root: rootA })
    projectB = service.registerProject({ name: 'Beta', root: rootB })
    caseA = service.recordProblem({
      project: { projectId: projectA.id },
      caseTitle: 'Alpha compiler failure',
      data: { summary: 'Compiler cannot resolve alpha', domain: 'build' },
    }).caseId
    service.recordProblem({
      project: { projectId: projectB.id },
      caseTitle: 'Beta compiler failure',
      data: { summary: 'Compiler cannot resolve beta', domain: 'build' },
    })
    running = await startTraceBenchServer({
      service,
      port: 0,
      sse: { pollIntervalMs: 10, heartbeatIntervalMs: 25, batchSize: 2 },
    })
  })

  afterEach(async () => {
    await running.close()
    closeDatabase(database)
    rmSync(sandbox, { recursive: true, force: true })
  })

  it('binds only to IPv4 loopback and serves health without permissive CORS', async () => {
    expect(running.address.address).toBe('127.0.0.1')
    expect(running.address.family).toBe('IPv4')

    const response = await get('/health')

    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ status: 'ok' })
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('rejects non-loopback Host and non-same-origin Origin headers', async () => {
    const hostileHost = await get('/health', { host: 'example.com' })
    const hostileOrigin = await get('/health', {
      origin: 'https://example.com',
    })
    const sameOrigin = await get('/health', {
      origin: `http://127.0.0.1:${running.address.port}`,
    })

    expect(hostileHost.status).toBe(403)
    expect(hostileOrigin.status).toBe(403)
    expect(sameOrigin.status).toBe(200)
    expect(hostileHost.headers['access-control-allow-origin']).toBeUndefined()
    expect(hostileOrigin.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('requires project scope and isolates graph, search, activity, and Case reads', async () => {
    const missingScope = await get('/api/v1/graph')
    const graph = await get(`/api/v1/graph?project_id=${projectA.id}`)
    const search = await get(
      `/api/v1/search?project_id=${projectA.id}&q=compiler&types=Problem&statuses=open`,
    )
    const activity = await get(`/api/v1/activity?project_id=${projectA.id}&after=0`)
    const ownCase = await get(`/api/v1/cases/${caseA}?project_id=${projectA.id}`)
    const foreignCase = await get(`/api/v1/cases/${caseA}?project_id=${projectB.id}`)

    expect(missingScope.status).toBe(400)
    expect(JSON.parse(graph.body)).toMatchObject({
      projectId: projectA.id,
      cases: [{ id: caseA, projectId: projectA.id }],
      asOfSequence: expect.any(Number),
    })
    expect(graph.body).not.toContain('Beta compiler failure')
    expect(JSON.parse(search.body)).toMatchObject({
      items: [{ projectId: projectA.id, caseId: caseA }],
      asOfSequence: expect.any(Number),
    })
    expect(activity.body).not.toContain(projectB.id)
    expect(JSON.parse(ownCase.body)).toMatchObject({
      id: caseA,
      projectId: projectA.id,
      asOfSequence: expect.any(Number),
    })
    expect(foreignCase.status).toBe(404)
  })

  it('bounds URLs and graph responses', async () => {
    for (let index = 0; index < 105; index += 1) {
      service.recordProblem({
        project: { projectId: projectA.id },
        caseTitle: `Bounded Case ${index}`,
        data: { summary: `Bounded problem ${index}` },
      })
    }

    const oversizedUrl = await get(`/api/v1/search?project_id=${projectA.id}&q=${'x'.repeat(2_100)}`)
    const graph = await get(`/api/v1/graph?project_id=${projectA.id}&limit=999`)
    const body = JSON.parse(graph.body) as { cases: unknown[]; truncated: boolean }

    expect(oversizedUrl.status).toBe(414)
    expect(graph.status).toBe(200)
    expect(body.cases).toHaveLength(100)
    expect(body.truncated).toBe(true)
    expect(Buffer.byteLength(graph.body)).toBeLessThanOrEqual(1_048_576)
  })

  it('maps malformed percent encoding to a client error', async () => {
    const response = await get(`/api/v1/cases/%E0%A4%A?project_id=${projectA.id}`)
    expect(response.status).toBe(400)
  })

  it('bounds nodes and edges inside a dense graph Case', async () => {
    const problem = service.recordProblem({
      project: { projectId: projectA.id },
      caseTitle: 'Dense Case',
      data: { summary: 'Dense graph problem' },
    })
    for (let index = 0; index < 105; index += 1) {
      service.recordAttempt({
        project: { projectId: projectA.id },
        caseId: problem.caseId,
        problemId: problem.nodeId,
        data: {
          hypothesis: `Attempt ${index}`,
          change: `Change ${index}`,
          outcome: 'failed',
          failureExplanation: `Still failing ${index}`,
        },
      })
    }

    const response = await get(
      `/api/v1/graph?project_id=${projectA.id}&q=Dense&limit=100`,
    )
    const body = JSON.parse(response.body) as {
      cases: Array<{ nodes: unknown[]; edges: Array<{ sourceId: string; targetId: string }>; graphTruncated: boolean }>
    }

    const denseCase = body.cases[0]
    expect(denseCase).toBeDefined()
    expect(denseCase?.nodes.length).toBeLessThanOrEqual(100)
    expect(denseCase?.edges.length).toBeLessThanOrEqual(200)
    expect(denseCase?.graphTruncated).toBe(true)
  })

  it('lists projects through the read contract', async () => {
    const response = await get('/api/v1/projects')

    const body = JSON.parse(response.body) as { projects: Array<{ id: string }> }
    expect(body.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: projectA.id }),
        expect.objectContaining({ id: projectB.id }),
      ]),
    )
  })

  it('serves only the Trace Bench static asset allowlist', async () => {
    const index = await get('/')
    const styles = await get('/styles.css')
    const script = await get('/app.js')
    const traversal = await get('/..%2Fpackage.json')

    expect(index.status).toBe(200)
    expect(index.headers['content-type']).toContain('text/html')
    expect(index.body).toContain('<title>Trace Bench</title>')
    expect(styles.headers['content-type']).toContain('text/css')
    expect(script.headers['content-type']).toContain('text/javascript')
    expect(traversal.status).toBe(404)
  })

  it('resumes SSE from Last-Event-ID exactly once across a separate SQLite writer', async () => {
    const snapshot = JSON.parse(
      (await get(`/api/v1/graph?project_id=${projectA.id}`)).body,
    ) as { asOfSequence: number }
    const firstStream = await openSse(
      `/api/v1/events?project_id=${projectA.id}&after=${snapshot.asOfSequence}`,
    )
    const writerDatabase = openDatabase(join(sandbox, 'knowledge.sqlite'))
    const writer = new KnowledgeService(writerDatabase)
    writer.recordProblem({
      project: { projectId: projectA.id },
      caseTitle: 'Written in another process',
      data: { summary: 'First live problem' },
    })
    const firstEvents = await firstStream.takeDataEvents(2)
    firstStream.close()
    const lastId = firstEvents.at(-1)?.id as number

    writer.recordProblem({
      project: { projectId: projectA.id },
      caseTitle: 'Missed while disconnected',
      data: { summary: 'Second live problem' },
    })
    const resumed = await openSse(`/api/v1/events?project_id=${projectA.id}&after=0`, {
      'last-event-id': String(lastId),
    })
    const resumedEvents = await resumed.takeDataEvents(2)
    resumed.close()
    closeDatabase(writerDatabase)

    const ids = [...firstEvents, ...resumedEvents].map((event) => event.id)
    expect(ids).toEqual([...ids].sort((left, right) => (left ?? 0) - (right ?? 0)))
    expect(new Set(ids).size).toBe(ids.length)
    expect(resumedEvents.every((event) => (event.id ?? 0) > lastId)).toBe(true)
  })

  it('filters SSE by project and emits heartbeats', async () => {
    const snapshot = JSON.parse(
      (await get(`/api/v1/graph?project_id=${projectA.id}`)).body,
    ) as { asOfSequence: number }
    const stream = await openSse(
      `/api/v1/events?project_id=${projectA.id}&after=${snapshot.asOfSequence}`,
    )
    service.recordProblem({
      project: { projectId: projectB.id },
      caseTitle: 'Foreign live problem',
      data: { summary: 'Must not cross the stream' },
    })
    service.recordProblem({
      project: { projectId: projectA.id },
      caseTitle: 'Own live problem',
      data: { summary: 'Visible in the stream' },
    })

    const events = await stream.takeEvents(3)
    stream.close()

    expect(events.some((event) => event.comment === 'heartbeat')).toBe(true)
    const dataEvents = events.filter((event) => event.data)
    expect(dataEvents).toHaveLength(2)
    expect(dataEvents.every((event) => event.data?.projectId === projectA.id)).toBe(true)
  })

  it('requests a fresh snapshot when the pending SSE gap exceeds a bounded batch', async () => {
    const snapshot = JSON.parse(
      (await get(`/api/v1/graph?project_id=${projectA.id}`)).body,
    ) as { asOfSequence: number }
    for (let index = 0; index < 2; index += 1) {
      service.recordProblem({
        project: { projectId: projectA.id },
        caseTitle: `Gap ${index}`,
        data: { summary: `Gap problem ${index}` },
      })
    }
    const stream = await openSse(
      `/api/v1/events?project_id=${projectA.id}&after=${snapshot.asOfSequence}`,
    )

    const events = await stream.takeDataEvents(1)
    stream.close()

    expect(events[0]).toMatchObject({
      event: 'snapshot_required',
      id: expect.any(Number),
      data: { projectId: projectA.id, reason: 'cursor_gap' },
    })
  })

  function get(path: string, headers: Record<string, string> = {}): Promise<ResponseResult> {
    return new Promise((resolve, reject) => {
      const clientRequest = request(
        {
          hostname: '127.0.0.1',
          port: running.address.port,
          path,
          method: 'GET',
          headers: {
            host: `127.0.0.1:${running.address.port}`,
            ...headers,
          },
        },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          )
        },
      )
      clientRequest.on('error', reject)
      clientRequest.end()
    })
  }

  function openSse(path: string, headers: Record<string, string> = {}): Promise<{
    takeEvents(count: number): Promise<SseEvent[]>
    takeDataEvents(count: number): Promise<SseEvent[]>
    close(): void
  }> {
    return new Promise((resolve, reject) => {
      const clientRequest = request({
        hostname: '127.0.0.1',
        port: running.address.port,
        path,
        method: 'GET',
        headers: {
          accept: 'text/event-stream',
          host: `127.0.0.1:${running.address.port}`,
          ...headers,
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
        const parsed: SseEvent[] = []
        const waiters: Array<{ count: number; dataOnly: boolean; resolve(events: SseEvent[]): void }> = []
        const flush = () => {
          for (let index = waiters.length - 1; index >= 0; index -= 1) {
            const waiter = waiters[index] as (typeof waiters)[number]
            const available = waiter.dataOnly ? parsed.filter((event) => event.data) : parsed
            if (available.length >= waiter.count) {
              waiters.splice(index, 1)
              waiter.resolve(available.slice(0, waiter.count))
            }
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
            if (event) parsed.push(event)
            boundary = buffer.indexOf('\n\n')
          }
          flush()
        })
        resolve({
          takeEvents: (count) => new Promise((resolveEvents) => {
            waiters.push({ count, dataOnly: false, resolve: resolveEvents })
            flush()
          }),
          takeDataEvents: (count) => new Promise((resolveEvents) => {
            waiters.push({ count, dataOnly: true, resolve: resolveEvents })
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
  if (block.startsWith(':')) return { comment: block.slice(1).trim() }
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
