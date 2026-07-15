import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'

import { KnowledgeService } from '../../src/application/knowledge-service.js'
import type { KnowledgeServiceContract } from '../../src/application/contracts.js'
import { createMcpServer } from '../../src/mcp/server.js'
import { runStdioServer } from '../../src/mcp/stdio.js'
import { closeDatabase, openDatabase } from '../../src/storage/database.js'

const TOOL_NAMES = [
  'register_project',
  'list_projects',
  'resolve_project',
  'update_project',
  'query_knowledge',
  'get_case',
  'get_preflight_guidance',
  'list_recent_activity',
  'get_operation_metrics',
  'record_problem',
  'record_attempt',
  'record_root_cause',
  'record_solution',
  'record_verification',
  'record_artifact_reference',
  'record_guardrail',
  'report_relevance',
  'suggest_case_merges',
  'apply_case_merge',
  'checkpoint_work',
  'finalize_work',
  'record_checkpoint',
  'record_command_result',
  'close_case',
  'mark_regression',
  'preview_import',
  'apply_import',
  'export_project_graph',
  'import_project_graph',
] as const

describe('MCP adapter', () => {
  const closeCallbacks: Array<() => Promise<void>> = []

  async function connect(service: KnowledgeServiceContract): Promise<Client> {
    const server = createMcpServer(service)
    const client = new Client({ name: 'ekg-test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    closeCallbacks.push(async () => {
      await client.close()
      await server.close()
    })
    return client
  }

  function serviceHarness(): {
    client: Promise<Client>
    database: Database.Database
    rootA: string
    rootB: string
  } {
    const database = openDatabase(':memory:')
    const sandbox = mkdtempSync(join(tmpdir(), 'ekg-mcp-'))
    const rootA = join(sandbox, 'project-a')
    const rootB = join(sandbox, 'project-b')
    mkdirSync(rootA)
    mkdirSync(rootB)
    closeCallbacks.push(async () => {
      closeDatabase(database)
      rmSync(sandbox, { recursive: true, force: true })
    })
    return {
      client: connect(new KnowledgeService(database)),
      database,
      rootA,
      rootB,
    }
  }

  async function call<T>(
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const response = (await client.callTool({ name, arguments: args })) as CallToolResult
    expect(response.isError, textOf(response)).not.toBe(true)
    expect(response.structuredContent).toMatchObject({ ok: true })
    return (response.structuredContent as { result: T }).result
  }

  function textOf(result: CallToolResult): string {
    return result.content
      .filter((item): item is Extract<typeof item, { type: 'text' }> => item.type === 'text')
      .map((item) => item.text)
      .join('\n')
  }

  afterEach(async () => {
    await Promise.all(closeCallbacks.splice(0).map((close) => close()))
  })

  it('initializes and discovers every bounded project-aware tool', async () => {
    const service = {} as KnowledgeServiceContract
    const client = await connect(service)

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name)).toEqual(TOOL_NAMES)
    expect(tools.every((tool) => tool.inputSchema.type === 'object')).toBe(true)
    expect(tools.every((tool) => tool.outputSchema?.type === 'object')).toBe(true)
    expect(tools.find((tool) => tool.name === 'query_knowledge')?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    })
    expect(tools.find((tool) => tool.name === 'import_project_graph')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    })
    const querySchema = JSON.stringify(tools.find((tool) => tool.name === 'query_knowledge')?.inputSchema)
    expect(querySchema).toContain('retired')
    const caseSchema = JSON.stringify(tools.find((tool) => tool.name === 'get_case')?.outputSchema)
    expect(caseSchema).toContain('SUPERSEDES')
    const caseInputSchema = JSON.stringify(tools.find((tool) => tool.name === 'get_case')?.inputSchema)
    expect(caseInputSchema).toContain('historyBeforeSequence')
    expect(caseInputSchema).toContain('full')
    expect(tools.find((tool) => tool.name === 'close_case')?.annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: true,
    })
    expect(tools.find((tool) => tool.name === 'mark_regression')?.annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: true,
    })
    const closeRequired = tools.find((tool) => tool.name === 'close_case')?.inputSchema.required
    expect(closeRequired).toContain('operationId')
    const regressionRequired = tools.find((tool) => tool.name === 'mark_regression')?.inputSchema.required
    expect(regressionRequired).toContain('operationId')

    const finalizeTool = tools.find((tool) => tool.name === 'finalize_work')!
    expect(finalizeTool.inputSchema.required).toEqual(expect.arrayContaining([
      'project', 'operationId', 'task', 'outcome', 'summary', 'merge',
    ]))
    expect(JSON.stringify(finalizeTool.inputSchema)).toContain('failedAttempts')
    expect(JSON.stringify(finalizeTool.inputSchema)).toContain('destination')
    expect((finalizeTool.inputSchema.properties?.files as { items?: unknown }).items)
      .toMatchObject({ type: 'string', minLength: 1 })
  })

  it('rejects invalid inputs without terminating the MCP session', async () => {
    const { client: clientPromise, rootA } = serviceHarness()
    const client = await clientPromise

    const response = (await client.callTool({
      name: 'register_project',
      arguments: { name: '', root: rootA },
    })) as CallToolResult

    expect(response.isError).toBe(true)
    expect(textOf(response)).toMatch(/input validation error[\s\S]*name/i)

    const missingProject = (await client.callTool({
      name: 'query_knowledge',
      arguments: { text: 'missing explicit project' },
    })) as CallToolResult
    expect(missingProject.isError).toBe(true)
    expect(textOf(missingProject)).toMatch(/project[\s\S]*required/i)

    expect((await client.listTools()).tools).toHaveLength(TOOL_NAMES.length)
  })

  it.each(['checkpoint_work', 'finalize_work'])(
    'reports an exact files item path for %s instead of invoking the service',
    async (name) => {
      const service = {
        checkpointWork: () => { throw new Error('service must not be invoked') },
        finalizeWork: () => { throw new Error('service must not be invoked') },
      } as unknown as KnowledgeServiceContract
      const client = await connect(service)
      const response = await client.callTool({
        name,
        arguments: {
          project: { projectId: 'project-1' }, operationId: 'operation-1', task: 'Task',
          outcome: 'failed', summary: 'Summary', files: [{ path: 'S1.swift' }],
          failedAttempts: [{ hypothesis: 'h', change: 'c', failureExplanation: 'f' }],
          merge: { status: 'pending' },
        },
      }) as CallToolResult
      expect(response.isError).toBe(true)
      expect(textOf(response)).toMatch(/files[\s\S]*0/i)
      expect(textOf(response)).not.toContain('service must not be invoked')
    },
  )

  it('captures a complete Case and keeps query results isolated by explicit project', async () => {
    const { client: clientPromise, rootA, rootB } = serviceHarness()
    const client = await clientPromise
    const projectA = await call<{ id: string }>(client, 'register_project', {
      name: 'Project A',
      root: rootA,
    })
    const projectB = await call<{ id: string }>(client, 'register_project', {
      name: 'Project B',
      root: rootB,
    })
    const project = { projectId: projectA.id }
    const problem = await call<{ caseId: string; nodeId: string }>(client, 'record_problem', {
      project,
      caseTitle: 'Generated module failure',
      data: {
        summary: 'Generated module is missing',
        domain: 'build',
        fingerprint: `${rootA}/src/generated.ts:42 missing`,
      },
    })
    const failedAttempt = await call<{ nodeId: string }>(client, 'record_attempt', {
      project,
      caseId: problem.caseId,
      problemId: problem.nodeId,
      data: {
        hypothesis: 'The cache is stale',
        change: 'Cleared the cache',
        outcome: 'failed',
        failureExplanation: 'Generated source remained absent',
      },
    })
    const successfulAttempt = await call<{ nodeId: string }>(client, 'record_attempt', {
      project,
      caseId: problem.caseId,
      problemId: problem.nodeId,
      previousAttemptId: failedAttempt.nodeId,
      data: {
        hypothesis: 'Generation must run before compilation',
        change: 'Added the generation step',
        outcome: 'succeeded',
        decisiveDifference: 'Generation now precedes compilation',
      },
    })
    const cause = await call<{ nodeId: string }>(client, 'record_root_cause', {
      project,
      caseId: problem.caseId,
      problemId: problem.nodeId,
      failedAttemptIds: [failedAttempt.nodeId],
      status: 'verified',
      humanConfirmed: true,
      data: {
        explanation: 'Compilation ran before source generation',
        evidence: ['Build trace showed the reversed order'],
        confidence: 0.98,
      },
    })
    const solution = await call<{ nodeId: string }>(client, 'record_solution', {
      project,
      caseId: problem.caseId,
      rootCauseId: cause.nodeId,
      data: {
        summary: 'Generate sources before compiling',
        applicability: ['Node 22 builds'],
        limitations: ['Requires the generator binary'],
        decisiveDifference: 'Generation now precedes compilation',
        applicabilityBoundary: { runtime: ['node-22'] },
      },
    })
    const verification = await call<{ nodeId: string }>(client, 'record_verification', {
      project,
      caseId: problem.caseId,
      solutionId: solution.nodeId,
      data: {
        kind: 'automated',
        succeeded: true,
        command: ['npm', 'test'],
        exitStatus: 0,
        excerpt: '85 tests passed',
      },
    })
    await call(client, 'record_artifact_reference', {
      project,
      caseId: problem.caseId,
      verificationId: verification.nodeId,
      data: { kind: 'test-report', uri: join(rootA, 'test-results.json') },
    })
    await call(client, 'record_verification', {
      project,
      caseId: problem.caseId,
      solutionId: solution.nodeId,
      data: { kind: 'human', succeeded: true, humanConfirmed: true },
    })
    await call(client, 'record_guardrail', {
      project,
      caseId: problem.caseId,
      rootCauseId: cause.nodeId,
      status: 'verified',
      data: {
        guidance: 'Run generation before tests',
        enforcement: 'warn',
        criteria: { commandIncludes: ['npm', 'test'] },
      },
    })
    await call(client, 'record_command_result', {
      project,
      caseId: problem.caseId,
      attemptId: successfulAttempt.nodeId,
      command: ['npm', 'test'],
      workingDirectory: rootA,
      exitStatus: 0,
      durationMs: 123,
      excerpt: '85 tests passed',
      rawLogArtifact: {
        kind: 'command-log', digestAlgorithm: 'sha256', digest: 'a'.repeat(64),
        byteSize: 85, retainedByteSize: 85, paths: [join(rootA, '.ekg', 'run.log')],
        segmentCount: 1, truncated: false,
      },
      startedAt: '2026-07-13T20:00:00.000Z',
      finishedAt: '2026-07-13T20:00:00.123Z',
    })
    await call(client, 'close_case', { project, caseId: problem.caseId, operationId: 'close-case' })
    const regression = await call<{ outcome: string }>(client, 'mark_regression', {
      project,
      caseId: problem.caseId,
      solutionId: solution.nodeId,
      fingerprint: `${rootA}/src/generated.ts:42 missing`,
      observedContext: { runtime: 'node-22' },
      operationId: 'mark-regression',
    })

    const queryA = await call<{ items: Array<{ caseId: string }> }>(client, 'query_knowledge', {
      project,
      text: 'Generated module',
    })
    const queryB = await call<{ items: Array<{ caseId: string }> }>(client, 'query_knowledge', {
      project: { projectId: projectB.id },
      text: 'Generated module',
    })
    const checkpoint = await call<{ results: unknown[]; created: boolean }>(
      client,
      'record_checkpoint',
      {
        project,
        operationId: 'mcp-checkpoint',
        writes: [{
          kind: 'attempt',
          input: {
            caseId: problem.caseId,
            problemId: problem.nodeId,
            data: { hypothesis: 'Checkpoint probe', change: 'Measured once', outcome: 'inconclusive' },
          },
        }],
      },
    )
    const detail = await call<{
      detail: string
      nodes: unknown[]
      commandRuns: unknown[]
      history: unknown[]
    }>(client, 'get_case', {
      project,
      caseId: problem.caseId,
      detail: 'full',
      historyLimit: 10,
    })
    const metrics = await call<Array<{ operation: string; count: number }>>(
      client,
      'get_operation_metrics',
      {},
    )

    expect(queryA.items.map((item) => item.caseId)).toContain(problem.caseId)
    expect(queryB.items).toEqual([])
    expect(metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'query_knowledge', count: 2 }),
      expect.objectContaining({ operation: 'get_case', count: 1 }),
    ]))
    expect(checkpoint).toMatchObject({ created: true, results: [expect.any(Object)] })
    expect(detail.nodes.length).toBeGreaterThanOrEqual(7)
    expect(detail.commandRuns).toHaveLength(1)
    expect(detail.detail).toBe('full')
    expect(detail.history.length).toBeLessThanOrEqual(10)
    expect(regression.outcome).toBe('regressed')
  })

  it('maps service failures to stable actionable tool errors', async () => {
    const { client: clientPromise, rootA } = serviceHarness()
    const client = await clientPromise
    const project = await call<{ id: string }>(client, 'register_project', {
      name: 'Project A',
      root: rootA,
    })

    const response = (await client.callTool({
      name: 'get_case',
      arguments: { project: { projectId: project.id }, caseId: 'missing-case' },
    })) as CallToolResult

    expect(response.isError).toBe(true)
    expect(textOf(response)).toMatch(/\[NOT_FOUND\].*missing-case.*Check the selected project and identifier/i)

    const exportResponse = (await client.callTool({
      name: 'export_project_graph',
      arguments: { project: { projectId: 'missing-project' } },
    })) as CallToolResult
    expect(exportResponse.isError).toBe(true)
    expect(textOf(exportResponse)).toMatch(/\[NOT_FOUND\].*missing-project/i)
    expect((await client.listTools()).tools).toHaveLength(TOOL_NAMES.length)
  })

  it('does not expose unknown internal error messages to MCP clients', async () => {
    const service = {
      getCase() {
        throw new Error('password=internal-database-secret')
      },
    } as unknown as KnowledgeServiceContract
    const client = await connect(service)

    const response = (await client.callTool({
      name: 'get_case',
      arguments: { project: { projectId: 'project-id' }, caseId: 'case-id' },
    })) as CallToolResult

    expect(response.isError).toBe(true)
    expect(textOf(response)).toMatch(/^\[INTERNAL_ERROR\] Unexpected service failure\./)
    expect(textOf(response)).not.toContain('internal-database-secret')
  })

  it('bounds nested metadata before invoking the service', async () => {
    let invoked = false
    const service = {
      recordArtifactReference() {
        invoked = true
        throw new Error('service should not be invoked')
      },
    } as unknown as KnowledgeServiceContract
    const client = await connect(service)

    const response = (await client.callTool({
      name: 'record_artifact_reference',
      arguments: {
        project: { projectId: 'project-id' },
        caseId: 'case-id',
        verificationId: 'verification-id',
        data: { kind: 'report', uri: '/project/report.json' },
        metadata: { note: 'x'.repeat(16_385) },
      },
    })) as CallToolResult

    expect(response.isError).toBe(true)
    expect(textOf(response)).toMatch(/input validation error/i)
    expect(invoked).toBe(false)
  })

  it('starts the stdio runner without writing diagnostics to protocol stdout', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let stdout = ''
    output.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })

    const handle = await runStdioServer({ databasePath: ':memory:', input, output })
    closeCallbacks.push(() => handle.close())

    expect(stdout).toBe('')
  })
})
