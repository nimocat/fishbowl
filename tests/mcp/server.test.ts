import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AwaitableKnowledgeBackend } from '../../src/application/backend.js'
import { createMcpServer } from '../../src/mcp/server.js'
import { runStdioServer } from '../../src/mcp/stdio.js'

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
    expect(tools.map(({ name }) => name)).toContain('get_operation_result')
    expect(tools.map(({ name }) => name)).toContain('start_disk_observation')
    expect(tools.map(({ name }) => name)).toContain('list_disk_cleanup_candidates')
    expect(tools).toHaveLength(34)
  })

  it('adapts MCP list_projects to the native backend without core logic', async () => {
    const listProjects = vi.fn(() => [{ id: 'p1', name: 'P', description: null, root: '/p', createdAt: new Date().toISOString(), aliases: [] }])
    const client = await connect({ listProjects } as unknown as AwaitableKnowledgeBackend)
    const response = await client.callTool({ name: 'list_projects', arguments: {} }) as CallToolResult
    expect(response.isError).not.toBe(true)
    expect(response.structuredContent).toMatchObject({ ok: true, result: [{ id: 'p1' }] })
    expect(listProjects).toHaveBeenCalledOnce()
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
      ok: true,
      result: {
        recorded: true,
        createdCase: true,
        caseId: 'case-1',
        problemId: 'problem-1',
        attemptId: 'attempt-1',
      },
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

    expect(operation.structuredContent).toMatchObject({ ok: true, result: { found: true, kind: 'checkpoint_work' } })
    expect(metrics.structuredContent).toMatchObject({ ok: true, result: [{ operation: 'checkpoint_work', count: 12 }] })
    expect(getOperationResult).toHaveBeenCalledOnce()
    expect(getOperationMetrics).toHaveBeenCalledOnce()
  })

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
