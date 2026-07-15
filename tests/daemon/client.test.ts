import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DaemonClient, DaemonClientError } from '../../src/daemon/client.js'
import { startDaemonServer } from '../../src/daemon/server.js'

describe('DaemonClient', () => {
  const cleanup: Array<() => void | Promise<void>> = []

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((close) => close()))
  })

  it('calls the daemon and retries once with the same request id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ekg-client-'))
    const project = join(root, 'project')
    mkdirSync(project)
    const running = await startDaemonServer({
      databasePath: join(root, 'knowledge.db'),
      token: 'secret-token',
      daemonVersion: 'test',
    })
    cleanup.push(running.close, () => rmSync(root, { recursive: true, force: true }))
    const requestIds: string[] = []
    let dropFirstResponse = true
    const client = new DaemonClient({
      descriptor: {
        protocolVersion: 1,
        daemonVersion: 'test',
        host: '127.0.0.1',
        port: running.address.port,
        instanceId: running.instanceId,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      },
      token: 'secret-token',
      observeRequestId: (value) => requestIds.push(value),
      afterResponse: () => {
        if (dropFirstResponse) {
          dropFirstResponse = false
          throw new Error('simulated response loss')
        }
      },
    })

    const registered = await client.call<{ id: string }>('registerProject', {
      name: 'Client project', root: project,
    }, { requestId: 'stable-r1' })

    expect(registered.id).toBeTruthy()
    expect(requestIds).toEqual(['stable-r1', 'stable-r1'])
    expect(await client.call('listProjects', {}, { requestId: 'list-r1' }))
      .toEqual([expect.objectContaining({ id: registered.id })])
  })

  it('returns bounded daemon guidance after one failed retry', async () => {
    let starts = 0
    const client = new DaemonClient({
      descriptor: {
        protocolVersion: 1,
        daemonVersion: 'test',
        host: '127.0.0.1',
        port: 1,
        instanceId: 'missing',
        pid: 999,
        startedAt: new Date().toISOString(),
      },
      token: 'secret-token',
      timeoutMs: 50,
      startInstalledService: async () => { starts += 1 },
    })

    await expect(client.call('listProjects', {})).rejects.toMatchObject({
      code: 'DAEMON_UNAVAILABLE',
    } satisfies Partial<DaemonClientError>)
    expect(starts).toBe(1)
  })
})
