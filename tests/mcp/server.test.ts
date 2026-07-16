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
    expect(tools).toHaveLength(29)
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
