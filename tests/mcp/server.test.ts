import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AwaitableKnowledgeBackend } from '../../src/application/backend.js'
import { createMcpServer } from '../../src/mcp/server.js'
import { runStdioServer } from '../../src/mcp/stdio.js'
import { DaemonClientError } from '../../src/daemon/client.js'

describe('MCP protocol adapter', () => {
  const cleanup: Array<() => Promise<void>> = []

  async function connect(backend: AwaitableKnowledgeBackend): Promise<Client> {
    const server = createMcpServer(backend)
    const client = new Client({ name: 'adapter-test', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    cleanup.push(async () => { await client.close(); await server.close() })
    return client
  }

  afterEach(async () => Promise.all(cleanup.splice(0).map((close) => close())))

  it('exposes the bounded native RPC tool surface', async () => {
    const client = await connect({} as AwaitableKnowledgeBackend)
    const { tools } = await client.listTools()
    expect(tools.map(({ name }) => name)).toContain('query_knowledge')
    expect(tools.map(({ name }) => name)).toContain('finalize_work')
    expect(tools.map(({ name }) => name)).toContain('promote_root_cause')
    expect(tools.map(({ name }) => name)).toContain('get_operation_result')
    expect(tools.map(({ name }) => name)).toContain('start_disk_observation')
    expect(tools.map(({ name }) => name)).toContain('list_disk_cleanup_candidates')
    expect(tools).toHaveLength(35)
  })

  it('publishes concrete finalize string-array items and a default merge disposition', async () => {
    const client = await connect({} as AwaitableKnowledgeBackend)
    const { tools } = await client.listTools()
    const finalize = tools.find(({ name }) => name === 'finalize_work')
    const schema = finalize?.inputSchema as {
      properties?: Record<string, {
        default?: unknown
        description?: string
        properties?: Record<string, { type?: string; items?: { type?: string } }>
      }>
    }

    expect(schema.properties?.rootCause?.properties?.evidence).toMatchObject({
      type: 'array', items: { type: 'string' },
    })
    expect(schema.properties?.solution?.properties?.applicability).toMatchObject({
      type: 'array', items: { type: 'string' },
    })
    expect(schema.properties?.solution?.properties?.limitations).toMatchObject({
      type: 'array', items: { type: 'string' },
    })
    expect(schema.properties?.merge?.default).toEqual({ status: 'not-required' })
    expect(schema.properties?.outcome?.description).toContain('succeeded requires commit')
    expect(schema.properties?.commit?.description).toContain('Required when outcome is succeeded')
    expect(schema.properties?.solution?.description).toContain('requires rootCause')
    expect(schema.properties?.verifications?.description).toContain('Automated items require command')
    expect(finalize?.description).toContain('failed/inconclusive requires failedAttempts')
  })

  it('defaults an omitted finalize merge disposition before backend dispatch', async () => {
    const finalizeWork = vi.fn(async (input) => ({
      recorded: true, createdCase: false, caseId: 'case-1', problemId: 'problem-1',
      attemptIds: [], verificationIds: [], artifactIds: [], mergeRecorded: true,
      promotion: { status: 'candidate', missingRequirements: [] },
    }))
    const client = await connect({ finalizeWork } as unknown as AwaitableKnowledgeBackend)
    const response = await client.callTool({ name: 'finalize_work', arguments: {
      project: { projectId: 'project-1' }, operationId: 'failed-with-default-merge',
      task: 'Investigate failure', outcome: 'failed', summary: 'Still failing',
      failedAttempts: [{ hypothesis: 'Route', change: 'Tried route', failureExplanation: 'No change' }],
    } }) as CallToolResult

    expect(response.isError, JSON.stringify(response)).not.toBe(true)
    expect(finalizeWork).toHaveBeenCalledWith(expect.objectContaining({
      merge: { status: 'not-required' },
    }))
  })

  it('adapts MCP list_projects to the native backend without core logic', async () => {
    const listProjects = vi.fn(() => [{ id: 'p1', name: 'P', description: null, root: '/p', createdAt: new Date().toISOString(), aliases: [] }])
    const client = await connect({ listProjects } as unknown as AwaitableKnowledgeBackend)
    const response = await client.callTool({ name: 'list_projects', arguments: {} }) as CallToolResult
    expect(response.isError).not.toBe(true)
    expect(response.structuredContent).toMatchObject({ outcome: { ok: true, result: [{ id: 'p1' }] } })
    expect(listProjects).toHaveBeenCalledOnce()
  })

  it('defaults MCP queries to five and preserves retrieval explanations', async () => {
    const queryKnowledge = vi.fn(async (input) => ({
      items: [{
        projectId: 'p1', caseId: 'c1', caseTitle: 'Relevant case',
        node: { id: 'n1', caseId: 'c1', type: 'Solution', status: 'verified', data: { summary: 'Fix' }, createdAt: '2026-07-18T00:00:00.000Z' },
        whyMatched: [{ kind: 'exact-file', value: 'src/a.ts' }], supportingPath: ['n1'],
      }],
      limit: input.limit, truncated: false,
      diagnostics: { mode: 'exact', seedCount: 0, candidateCaseCount: 1, visitedNodes: 1, visitedEdges: 0, iterations: 0 },
    }))
    const client = await connect({ queryKnowledge } as unknown as AwaitableKnowledgeBackend)
    const response = await client.callTool({ name: 'query_knowledge', arguments: {
      project: { projectId: 'p1' }, file: 'src/a.ts',
    } }) as CallToolResult
    expect(response.isError, JSON.stringify(response)).not.toBe(true)
    expect(queryKnowledge).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }))
    expect(response.structuredContent).toMatchObject({
      outcome: { result: { items: [{ summary: 'Fix', node: { data: { summary: 'Fix' } }, whyMatched: [{ kind: 'exact-file' }], supportingPath: ['n1'] }] } },
    })
  })

  it('rejects an oversized adapter payload before native dispatch', async () => {
    const recordProblem = vi.fn()
    const client = await connect({ recordProblem } as unknown as AwaitableKnowledgeBackend)
    const response = await client.callTool({ name: 'record_problem', arguments: {
      project: { projectId: 'p1' },
      data: { summary: 'x'.repeat(4_097) },
    } }) as CallToolResult
    expect(response.isError).toBe(true)
    expect(recordProblem).not.toHaveBeenCalled()
  })

  it('accepts daemon nulls for omitted checkpoint fields without MCP output validation failure', async () => {
    const checkpointWork = vi.fn(async () => ({
      recorded: true,
      reason: null,
      createdCase: true,
      caseId: 'case-1',
      problemId: 'problem-1',
      attemptId: 'attempt-1',
      rootCauseId: null,
      solutionId: null,
    }))
    const client = await connect({ checkpointWork } as unknown as AwaitableKnowledgeBackend)

    const response = await client.callTool({ name: 'checkpoint_work', arguments: {
      project: { projectId: 'project-1' },
      operationId: 'checkpoint-null-optionals',
      task: 'Plan Fishbowl compatibility fix',
      outcome: 'inconclusive',
      summary: 'Planning checkpoint',
    } }) as CallToolResult

    expect(response.isError, JSON.stringify(response)).not.toBe(true)
    expect(response.structuredContent).toEqual({
      outcome: { ok: true, error: null, result: {
        recorded: true,
        createdCase: true,
        caseId: 'case-1',
        problemId: 'problem-1',
        attemptId: 'attempt-1',
      } },
    })
  })

  it('queries durable operation status and daemon-owned metrics through the backend', async () => {
    const getOperationResult = vi.fn(async () => ({
      found: true,
      operationId: 'write-1',
      kind: 'checkpoint_work',
      result: { recorded: true, caseId: 'case-1' },
      createdAt: '2026-07-18T00:00:00.000Z',
    }))
    const getOperationMetrics = vi.fn(async () => [{
      operation: 'checkpoint_work', count: 12, errors: 1,
      p50DurationMs: 2, p95DurationMs: 5, maxDurationMs: 8, maxResponseBytes: 512,
      p95DaemonQueueMs: 0, p95DaemonExecutionMs: 4, p95DaemonSerializationMs: 1,
      p95TransportMs: 0, p95McpHostMs: 0,
    }])
    const client = await connect({ getOperationResult, getOperationMetrics } as unknown as AwaitableKnowledgeBackend)

    const operation = await client.callTool({ name: 'get_operation_result', arguments: {
      project: { projectId: 'project-1' }, operationId: 'write-1', kind: 'checkpoint_work',
    } }) as CallToolResult
    const metrics = await client.callTool({ name: 'get_operation_metrics', arguments: {
      project: { projectId: 'project-1' },
    } }) as CallToolResult

    expect(operation.structuredContent).toMatchObject({ outcome: { ok: true, result: { found: true, kind: 'checkpoint_work' } } })
    expect(metrics.structuredContent).toMatchObject({ outcome: { ok: true, result: [{ operation: 'checkpoint_work', count: 12 }] } })
    expect(getOperationResult).toHaveBeenCalledOnce()
    expect(getOperationMetrics).toHaveBeenCalledOnce()
  })

  it('keeps the legacy empty metrics request on the MCP bridge', async () => {
    const getOperationMetrics = vi.fn()
    const client = await connect({ getOperationMetrics } as unknown as AwaitableKnowledgeBackend)
    await client.callTool({ name: 'list_projects', arguments: {} })

    const response = await client.callTool({ name: 'get_operation_metrics', arguments: {} }) as CallToolResult

    expect(response.isError, JSON.stringify(response)).not.toBe(true)
    expect(response.structuredContent).toMatchObject({
      outcome: { ok: true, result: [expect.objectContaining({ operation: 'list_projects', count: 1 })] },
    })
    expect(getOperationMetrics).not.toHaveBeenCalled()
  })

  it('accepts null disk summary measurements from running or truncated observations', async () => {
    const listDiskObservations = vi.fn(async () => ({
      observations: [{
        observationId: 'obs-1', task: 'bounded build', status: 'completed',
        startedAt: '2026-07-18T00:00:00.000Z', finishedAt: '2026-07-18T00:01:00.000Z',
        baselineTrackedBytes: 10, finalTrackedBytes: 20, deltaBytes: null,
        positiveGrowthBytes: 0, overlappingObservations: 0, scanTruncated: true,
      }, {
        observationId: 'obs-2', task: 'running build', status: 'running',
        startedAt: '2026-07-18T00:02:00.000Z', finishedAt: null,
        baselineTrackedBytes: 20, finalTrackedBytes: null, deltaBytes: null,
        positiveGrowthBytes: null, overlappingObservations: 0, scanTruncated: false,
      }], limit: 10, truncated: false,
    }))
    const client = await connect({ listDiskObservations } as unknown as AwaitableKnowledgeBackend)
    const response = await client.callTool({ name: 'list_disk_observations', arguments: {
      project: { projectId: 'project-1' }, limit: 10,
    } }) as CallToolResult
    expect(response.isError, JSON.stringify(response)).not.toBe(true)
    expect(response.structuredContent).toMatchObject({
      outcome: { result: { observations: [{ deltaBytes: null }, { finishedAt: null, deltaBytes: null }] } },
    })
  })

  it.each(['INVALID_REQUEST', 'PROTOCOL_MISMATCH', 'DAEMON_UNAVAILABLE', 'INVALID_RESPONSE']) (
    'preserves actionable daemon error code %s',
    async (code) => {
      const listProjects = vi.fn(async () => { throw new DaemonClientError(code, 'daemon detail') })
      const client = await connect({ listProjects } as unknown as AwaitableKnowledgeBackend)
      const response = await client.callTool({ name: 'list_projects', arguments: {} }) as CallToolResult
      expect(response.isError).toBe(true)
      expect(response.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining(`[${code}] daemon detail`) }),
      ]))
      expect(JSON.stringify(response)).not.toContain('INTERNAL_ERROR')
    },
  )

  it('reports finalize cross-field validation with an actionable field path', async () => {
    const finalizeWork = vi.fn()
    const client = await connect({ finalizeWork } as unknown as AwaitableKnowledgeBackend)
    const response = await client.callTool({ name: 'finalize_work', arguments: {
      project: { projectId: 'project-1' },
      operationId: 'finalize-invalid',
      task: 'Finish reliability work',
      outcome: 'succeeded',
      summary: 'Missing commit and successful verification',
      merge: { status: 'pending' },
    } }) as CallToolResult

    expect(response.isError).toBe(true)
    expect(response.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining('commit') }),
    ]))
    expect(response.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining('verifications') }),
    ]))
    expect(finalizeWork).not.toHaveBeenCalled()
  })

  it('rejects empty finalize semantic lists before native dispatch', async () => {
    const finalizeWork = vi.fn()
    const client = await connect({ finalizeWork } as unknown as AwaitableKnowledgeBackend)
    const response = await client.callTool({ name: 'finalize_work', arguments: {
      project: { projectId: 'project-1' }, operationId: 'finalize-empty-evidence',
      task: 'Finish work', outcome: 'succeeded', summary: 'Done',
      commit: { sha: 'abc', message: 'done' },
      rootCause: { explanation: 'Cause', confidence: 1, evidence: [] },
      solution: { summary: 'Fix', applicability: [], limitations: [], decisiveDifference: 'Works' },
      verifications: [{ kind: 'human', succeeded: true, excerpt: 'confirmed', humanConfirmed: true }],
      merge: { status: 'pending' },
    } }) as CallToolResult
    expect(response.isError).toBe(true)
    expect(JSON.stringify(response)).toContain('rootCause')
    expect(JSON.stringify(response)).toContain('evidence')
    expect(JSON.stringify(response)).toContain('applicability')
    expect(JSON.stringify(response)).toContain('limitations')
    expect(finalizeWork).not.toHaveBeenCalled()
  })

  it('rejects a checkpoint solution without a root cause before native dispatch', async () => {
    const checkpointWork = vi.fn()
    const client = await connect({ checkpointWork } as unknown as AwaitableKnowledgeBackend)
    const response = await client.callTool({ name: 'checkpoint_work', arguments: {
      project: { projectId: 'project-1' }, operationId: 'checkpoint-invalid',
      task: 'Checkpoint', outcome: 'succeeded', summary: 'Done',
      solution: { summary: 'Fix', applicability: ['here'], limitations: ['bounded'], decisiveDifference: 'Works' },
    } }) as CallToolResult
    expect(response.isError).toBe(true)
    expect(JSON.stringify(response)).toContain('rootCause')
    expect(checkpointWork).not.toHaveBeenCalled()
  })

  it('starts stdio without writing diagnostics into protocol stdout', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let stdout = ''
    output.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    const handle = await runStdioServer({ backend: {} as AwaitableKnowledgeBackend, input, output })
    cleanup.push(() => handle.close())
    expect(stdout).toBe('')
  })
})
