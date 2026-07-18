import { describe, expect, it } from 'vitest'

import { DaemonClient, DaemonClientError, daemonRequestTimeoutMs } from '../../src/daemon/client.js'

describe('DaemonClient adapter', () => {
  it('uses one bounded default while allowing explicit caller policy', () => {
    expect(daemonRequestTimeoutMs('queryKnowledge')).toBe(1_500)
    expect(daemonRequestTimeoutMs('queryKnowledge', 250)).toBe(250)
  })

  it('rejects a mismatched native protocol before network access', () => {
    expect(() => new DaemonClient({
      descriptor: {
        protocolVersion: 999,
        daemonVersion: 'test',
        host: '127.0.0.1',
        port: 1,
        instanceId: 'mismatch',
        pid: 1,
        startedAt: new Date().toISOString(),
      } as never,
      token: 'token',
    })).toThrow(/protocol mismatch/i)
  })

  it('retries one native startup and returns bounded unavailable guidance', async () => {
    let starts = 0
    const client = new DaemonClient({
      descriptor: {
        protocolVersion: 2,
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
