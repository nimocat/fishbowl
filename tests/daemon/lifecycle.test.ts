import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ensureDaemonCredentials, resolveDaemonPaths, writeDaemonDescriptor } from '../../src/daemon/config.js'
import { ensureInstalledDaemon } from '../../src/daemon/lifecycle.js'

describe('installed daemon lifecycle', () => {
  const sandboxes: string[] = []

  afterEach(() => {
    for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true })
  })

  it('uses the short deadline only for readiness and returns a normal operational client', async () => {
    const token = 'a'.repeat(64)
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { requestId: string; operation: string }
        const send = () => {
          response.setHeader('Content-Type', 'application/json')
          response.end(JSON.stringify({
            ok: true,
            requestId: payload.requestId,
            result: payload.operation === 'listProjects' ? [] : { ready: true },
          }))
        }
        send()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('missing listener')
      const sandbox = mkdtempSync(join(tmpdir(), 'fishbowl-lifecycle-'))
      sandboxes.push(sandbox)
      const dataDirectory = join(sandbox, 'data')
      const paths = resolveDaemonPaths({
        platform: process.platform,
        home: sandbox,
        environment: { FISHBOWL_DATA_DIR: dataDirectory },
      })
      ensureDaemonCredentials({ paths })
      writeFileSync(paths.tokenFile, token)
      writeDaemonDescriptor(paths, {
        protocolVersion: 2,
        daemonVersion: 'test',
        host: '127.0.0.1',
        port: address.port,
        instanceId: 'lifecycle-test',
        pid: process.pid,
        startedAt: new Date().toISOString(),
      })
      const installed = await ensureInstalledDaemon({
        environment: { FISHBOWL_DATA_DIR: dataDirectory },
        home: sandbox,
        platform: process.platform,
      })
      await expect(installed.client.call('queryKnowledge', {})).resolves.toMatchObject({ ready: true })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })
})
