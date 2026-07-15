import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'

import { DaemonClient, createDaemonBackend } from '../../src/daemon/client.js'
import { startDaemonServer } from '../../src/daemon/server.js'
import { createMcpServer } from '../../src/mcp/server.js'

describe('finalized delivery workflow', () => {
  it('persists one retry-safe engineering handoff through daemon-backed MCP clients', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ekg-finalize-acceptance-'))
    const projectRoot = join(root, 'project')
    const otherRoot = join(root, 'other')
    mkdirSync(projectRoot)
    mkdirSync(otherRoot)
    const running = await startDaemonServer({
      databasePath: join(root, 'knowledge.db'), token: 'finalize-flow-token', daemonVersion: 'test',
    })
    const daemon = new DaemonClient({
      descriptor: {
        protocolVersion: 1, daemonVersion: 'test', host: '127.0.0.1', port: running.address.port,
        instanceId: running.instanceId, pid: process.pid, startedAt: new Date().toISOString(),
      },
      token: 'finalize-flow-token',
    })
    const backend = createDaemonBackend(daemon)
    const connections: Array<{ client: Client; server: ReturnType<typeof createMcpServer> }> = []

    async function connect(name: string): Promise<Client> {
      const server = createMcpServer(backend)
      const client = new Client({ name, version: '1.0.0' })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      connections.push({ client, server })
      return client
    }

    async function call<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
      const response = await client.callTool({ name, arguments: args }) as CallToolResult
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true)
      return (response.structuredContent as { result: T }).result
    }

    try {
      const writer = await connect('writer')
      const reader = await connect('reader')
      const project = await call<{ id: string }>(writer, 'register_project', {
        name: 'Finalize Acceptance', root: projectRoot,
      })
      const other = await call<{ id: string }>(writer, 'register_project', {
        name: 'Other', root: otherRoot,
      })
      const request = {
        project: { projectId: project.id }, operationId: 'delivery-s1-20260715',
        task: 'Keep schema-v1 and validate on device', outcome: 'succeeded',
        summary: 'Automated and physical-device checks passed', files: ['S1ProFeatureFrontend.swift'],
        commit: { sha: 'abc1234', message: 'fix: keep schema v1', branch: 'feature/s1' },
        failedAttempts: [{
          hypothesis: 'schema-v2 is accepted', change: 'Enabled schema-v2',
          failureExplanation: 'Physical-device compiler rejected schema-v2', command: ['xcodebuild', 'test'],
        }],
        rootCause: {
          explanation: 'The device compiler supports schema-v1 only', confidence: 0.95,
          evidence: ['Bounded physical-device compiler excerpt'], rejectedAlternatives: ['Cache staleness'],
        },
        solution: {
          summary: 'Keep schema-v1', applicability: ['S1 Pro'], limitations: ['schema-v2 unavailable'],
          decisiveDifference: 'Restored the supported schema-v1 contract',
        },
        verifications: [
          { kind: 'automated', succeeded: true, command: ['xcodebuild', 'test'], excerpt: 'tests passed' },
          { kind: 'device', succeeded: true, excerpt: 'physical device passed', environment: { destination: 'iPhone 17 Pro', scheme: 'YQSK' } },
        ],
        merge: { status: 'merged', sourceBranch: 'feature/s1', targetBranch: 'main', mergeCommit: 'def5678' },
      }
      const first = await call<{ caseId: string; attemptIds: string[] }>(writer, 'finalize_work', request)
      const replay = await call<typeof first>(writer, 'finalize_work', request)
      expect(replay).toEqual(first)

      const detail = await call<{
        nodes: Array<{ id: string; type: string; data: Record<string, unknown> }>
        edges: Array<{ sourceId: string; relation: string; targetId: string }>
        artifacts: Array<{ uri: string }>
      }>(reader, 'get_case', {
        project: { projectId: project.id }, caseId: first.caseId, detail: 'full', historyLimit: 100,
      })
      expect(detail.nodes.map((node) => node.type)).toEqual([
        'Problem', 'Attempt', 'Attempt', 'RootCause', 'Solution', 'Verification', 'Verification', 'Artifact', 'Artifact',
      ])
      const precedence = detail.edges.find((edge) => edge.relation === 'PRECEDED_BY')
      expect(precedence).toMatchObject({ sourceId: first.attemptIds[1], targetId: first.attemptIds[0] })
      expect(detail.artifacts.map((artifact) => artifact.uri)).toEqual(['git:commit:abc1234', 'git:merge:def5678'])
      expect(JSON.stringify(detail).length).toBeLessThan(64 * 1024)

      const isolated = await reader.callTool({
        name: 'get_case', arguments: { project: { projectId: other.id }, caseId: first.caseId },
      }) as CallToolResult
      expect(isolated.isError).toBe(true)
    } finally {
      await Promise.all(connections.map(async ({ client, server }) => {
        await client.close()
        await server.close()
      }))
      await running.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
