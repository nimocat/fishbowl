import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { startDaemonServer, type RunningDaemonServer } from '../../src/daemon/server.js'

interface HttpResult {
  status: number
  body: Record<string, unknown>
}

describe('EKG daemon server', () => {
  let sandbox: string
  let running: RunningDaemonServer
  const token = 'a'.repeat(64)

  beforeEach(async () => {
    sandbox = mkdtempSync(join(tmpdir(), 'ekg-daemon-server-'))
    mkdirSync(join(sandbox, 'project'))
    running = await startDaemonServer({
      databasePath: join(sandbox, 'knowledge.db'),
      token,
      daemonVersion: '0.1.0-test',
      port: 0,
    })
  })

  afterEach(async () => {
    await running.close()
    rmSync(sandbox, { recursive: true, force: true })
  })

  it('serves bounded health and requires bearer auth for RPC', async () => {
    const health = await call('/health', 'GET')
    expect(health).toMatchObject({
      status: 200,
      body: { status: 'ok', protocolVersion: 1, daemonVersion: '0.1.0-test' },
    })
    expect(health.body).not.toHaveProperty('token')

    expect((await call('/rpc', 'POST', validRequest())).status).toBe(401)
    expect((await call('/rpc', 'POST', validRequest(), 'wrong')).status).toBe(401)

    const result = await call('/rpc', 'POST', validRequest(), token)
    expect(result).toEqual({ status: 200, body: { ok: true, result: [] } })
  })

  it('rejects incompatible protocol, unknown operations, hostile hosts, and oversized input', async () => {
    const incompatible = await call('/rpc', 'POST', {
      ...validRequest(),
      protocolVersion: 999,
    }, token)
    expect(incompatible).toMatchObject({
      status: 409,
      body: { ok: false, error: { code: 'PROTOCOL_MISMATCH' } },
    })

    const unknown = await call('/rpc', 'POST', {
      ...validRequest(),
      operation: 'readArbitraryFile',
      input: { secret: 'must-not-be-echoed' },
    }, token)
    expect(unknown.status).toBe(400)
    expect(JSON.stringify(unknown.body)).not.toContain('must-not-be-echoed')

    const hostile = await call('/rpc', 'POST', validRequest(), token, {
      host: 'example.com',
    })
    expect(hostile.status).toBe(403)

    const oversized = await call('/rpc', 'POST', {
      ...validRequest(),
      input: { text: 'x'.repeat(70 * 1024) },
    }, token)
    expect(oversized.status).toBe(413)
  })

  it('dispatches project writes and replays a recent request id without duplicate writes', async () => {
    const requestBody = {
      protocolVersion: 1,
      requestId: 'register-1',
      operation: 'registerProject',
      input: { name: 'Daemon Project', root: join(sandbox, 'project') },
    }
    const first = await call('/rpc', 'POST', requestBody, token)
    const second = await call('/rpc', 'POST', requestBody, token)
    const projects = await call('/rpc', 'POST', {
      ...validRequest(),
      requestId: 'list-2',
    }, token)

    expect(first).toEqual(second)
    expect(first.body).toMatchObject({ ok: true, result: { name: 'Daemon Project' } })
    expect(projects.body).toMatchObject({ ok: true, result: [{ name: 'Daemon Project' }] })
  })

  function validRequest(): Record<string, unknown> {
    return {
      protocolVersion: 1,
      requestId: 'list-1',
      operation: 'listProjects',
      input: {},
    }
  }

  function call(
    path: string,
    method: 'GET' | 'POST',
    body?: Record<string, unknown>,
    bearer?: string,
    headers: Record<string, string> = {},
  ): Promise<HttpResult> {
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    return new Promise((resolve, reject) => {
      const outgoing = request({
        hostname: running.address.address,
        port: running.address.port,
        path,
        method,
        headers: {
          host: `127.0.0.1:${running.address.port}`,
          ...(encoded && { 'content-type': 'application/json', 'content-length': String(encoded.length) }),
          ...(bearer && { authorization: `Bearer ${bearer}` }),
          ...headers,
        },
      }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : {} })
        })
      })
      outgoing.once('error', reject)
      if (encoded) outgoing.write(encoded)
      outgoing.end()
    })
  }
})
