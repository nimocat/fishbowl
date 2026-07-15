import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { runCli } from '../../src/cli/main.js'
import { DaemonClient, createDaemonBackend } from '../../src/daemon/client.js'
import { startDaemonServer } from '../../src/daemon/server.js'

describe('remote daemon workflow', () => {
  it('shares one persistent store across thin CLI calls', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ekg-daemon-flow-'))
    const project = join(root, 'project')
    mkdirSync(project)
    const running = await startDaemonServer({ databasePath: join(root, 'knowledge.db'), token: 'flow-token', daemonVersion: 'test' })
    const client = new DaemonClient({
      descriptor: { protocolVersion: 1, daemonVersion: 'test', host: '127.0.0.1', port: running.address.port, instanceId: running.instanceId, pid: process.pid, startedAt: new Date().toISOString() },
      token: 'flow-token',
    })
    const backend = createDaemonBackend(client)
    const output = () => {
      let text = ''
      return { stream: { write: (value: string | Uint8Array) => ((text += value.toString()), true) }, read: () => text }
    }
    try {
      const registeredOutput = output()
      expect(await runCli(['project', 'register', '--root', project, '--name', 'Remote'], { backend, stdout: registeredOutput.stream })).toBe(0)
      const id = (JSON.parse(registeredOutput.read()) as { id: string }).id
      const listOutput = output()
      expect(await runCli(['project', 'list'], { backend, stdout: listOutput.stream })).toBe(0)
      expect(JSON.parse(listOutput.read())).toEqual([expect.objectContaining({ id })])
    } finally {
      await running.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
