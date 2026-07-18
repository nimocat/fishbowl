import { describe, expect, it } from 'vitest'

import { stopInstalledDaemonIfRunning, waitForInstalledDaemonReady, waitForProcessExit } from '../../src/cli/main.js'
import type { DaemonDescriptor, DaemonPaths } from '../../src/daemon/config.js'

function processError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

describe('daemon process exit wait', () => {
  it('returns only after the process no longer exists', async () => {
    let now = 0
    let probes = 0
    await waitForProcessExit(42, {
      timeoutMs: 100,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds },
      signal: () => {
        probes += 1
        if (probes > 1) throw processError('ESRCH')
      },
    })
    expect(probes).toBe(2)
  })

  it('treats EPERM as still running and fails at the bounded timeout', async () => {
    let now = 0
    await expect(waitForProcessExit(42, {
      timeoutMs: 50,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds },
      signal: () => { throw processError('EPERM') },
    })).rejects.toThrow('did not stop within 50ms')
  })

  it('does not misreport unexpected probe errors as a stopped process', async () => {
    await expect(waitForProcessExit(42, {
      signal: () => { throw processError('EACCES') },
    })).rejects.toMatchObject({ code: 'EACCES' })
  })
})

describe('authenticated daemon replacement', () => {
  const paths = { descriptorFile: 'descriptor' } as DaemonPaths
  const descriptor: DaemonDescriptor = {
    protocolVersion: 2,
    daemonVersion: '0.1.0',
    host: '127.0.0.1',
    port: 43123,
    instanceId: 'instance',
    pid: 42,
    startedAt: '2026-07-18T00:00:00.000Z',
  }

  it('authenticates, terminates, and waits before a daemon installation replaces registration', async () => {
    const events: string[] = []
    const stopped = await stopInstalledDaemonIfRunning({ paths, token: 'a'.repeat(64) }, {
      readDescriptor: () => descriptor,
      signal: (_pid, signal) => { events.push(`signal:${signal}`) },
      authenticate: async () => { events.push('authenticate') },
      wait: async () => { events.push('wait') },
    })

    expect(stopped).toBe(true)
    expect(events).toEqual(['signal:0', 'authenticate', 'signal:SIGTERM', 'wait'])
  })

  it('never signals a running PID when authenticated validation fails', async () => {
    const signals: Array<NodeJS.Signals | 0> = []
    await expect(stopInstalledDaemonIfRunning({ paths, token: 'a'.repeat(64) }, {
      readDescriptor: () => descriptor,
      signal: (_pid, signal) => { signals.push(signal) },
      authenticate: async () => { throw new Error('wrong process') },
      wait: async () => {},
    })).rejects.toThrow(/refusing to replace/i)

    expect(signals).toEqual([0])
  })
})

describe('registered daemon readiness', () => {
  it('does not report installation success until the new descriptor is authenticated on the persisted port', async () => {
    let now = 0
    let reads = 0
    const authenticated: number[] = []
    const ready = await waitForInstalledDaemonReady({ paths: {} as DaemonPaths, token: 'a'.repeat(64), port: 56_341 }, {
      timeoutMs: 100,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds },
      readDescriptor: () => ({
        protocolVersion: 2,
        daemonVersion: '0.1.0',
        host: '127.0.0.1',
        port: reads++ === 0 ? 54_199 : 56_341,
        instanceId: `instance-${reads}`,
        pid: 42,
        startedAt: '2026-07-18T00:00:00.000Z',
      }),
      authenticate: async (candidate) => { authenticated.push(candidate.port) },
    })

    expect(ready.port).toBe(56_341)
    expect(authenticated).toEqual([56_341])
  })

  it('returns an actionable fixed-port error after the bounded readiness timeout', async () => {
    let now = 0
    await expect(waitForInstalledDaemonReady({ paths: {} as DaemonPaths, token: 'a'.repeat(64), port: 56_341 }, {
      timeoutMs: 50,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds },
      readDescriptor: () => { throw new Error('not published') },
    })).rejects.toThrow(/port 56341.*daemon\.port.*doctor/i)
  })
})
