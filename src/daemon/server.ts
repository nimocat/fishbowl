import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { KnowledgeService, KnowledgeServiceError } from '../application/knowledge-service.js'
import { closeDatabase, openDatabase } from '../storage/database.js'
import { startTraceBenchServer, type RunningTraceBenchServer } from '../http/server.js'
import { DAEMON_PROTOCOL_VERSION } from './config.js'
import { dispatchDaemonOperation } from './operations.js'
import {
  daemonRequestSchema,
  type DaemonFailure,
  type DaemonSuccess,
  protocolMismatch,
} from './protocol.js'

const LOOPBACK = '127.0.0.1'
const MAX_REQUEST_BYTES = 64 * 1024
const MAX_RECENT_REQUESTS = 1_000

export interface StartDaemonServerOptions {
  databasePath: string
  token: string
  daemonVersion: string
  port?: number
  traceBenchPort?: number | false
}

export interface RunningDaemonServer {
  server: Server
  address: AddressInfo
  instanceId: string
  traceBench?: RunningTraceBenchServer
  close(): Promise<void>
}

export async function startDaemonServer(
  options: StartDaemonServerOptions,
): Promise<RunningDaemonServer> {
  if (!options.token) throw new Error('Daemon token is required')
  const database = openDatabase(options.databasePath)
  const service = new KnowledgeService(database)
  let traceBench: RunningTraceBenchServer | undefined
  const instanceId = randomUUID()
  const recent = new Map<string, { status: number; body: DaemonSuccess | DaemonFailure }>()
  const server = createServer((request, response) => {
    void routeRequest(request, response, options, service, instanceId, recent)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.port ?? 0, LOOPBACK, () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch (error) {
    closeDatabase(database)
    throw error
  }
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    closeDatabase(database)
    throw new Error('EKG daemon did not obtain a TCP address')
  }
  try {
    if (options.traceBenchPort !== false) {
      traceBench = await startTraceBenchServer({ service, port: options.traceBenchPort })
    }
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(database)
    throw error
  }
  return {
    server,
    address,
    instanceId,
    traceBench,
    close: async () => {
      await traceBench?.close()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
      closeDatabase(database)
    },
  }
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: StartDaemonServerOptions,
  service: KnowledgeService,
  instanceId: string,
  recent: Map<string, { status: number; body: DaemonSuccess | DaemonFailure }>,
): Promise<void> {
  applyHeaders(response)
  if (!isLoopbackHost(request.headers.host)) {
    writeFailure(response, 403, 'FORBIDDEN', 'Loopback Host required')
    return
  }
  const origin = request.headers.origin
  if (origin && origin !== `http://${request.headers.host}`) {
    writeFailure(response, 403, 'FORBIDDEN', 'Same-origin requests required')
    return
  }
  if (request.url === '/health' && request.method === 'GET') {
    writeJson(response, 200, {
      status: 'ok',
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      daemonVersion: options.daemonVersion,
      instanceId,
    })
    return
  }
  if (request.url !== '/rpc' || request.method !== 'POST') {
    writeFailure(response, 404, 'NOT_FOUND', 'Route not found')
    return
  }
  if (!authorized(request.headers.authorization, options.token)) {
    writeFailure(response, 401, 'UNAUTHORIZED', 'Bearer token required')
    return
  }
  const body = await readBoundedBody(request)
  if (body.tooLarge) {
    writeFailure(response, 413, 'PAYLOAD_TOO_LARGE', 'Request exceeds 65536 bytes')
    return
  }
  let raw: unknown
  try {
    raw = JSON.parse(body.text)
  } catch {
    writeFailure(response, 400, 'INVALID_JSON', 'Request body must be JSON')
    return
  }
  if (
    typeof raw === 'object' && raw !== null &&
    'protocolVersion' in raw && typeof raw.protocolVersion === 'number' &&
    protocolMismatch(raw.protocolVersion)
  ) {
    writeFailure(response, 409, 'PROTOCOL_MISMATCH', 'Daemon protocol version is incompatible')
    return
  }
  const parsed = daemonRequestSchema.safeParse(raw)
  if (!parsed.success) {
    writeFailure(response, 400, 'INVALID_REQUEST', 'Request shape or operation is invalid')
    return
  }
  const replay = recent.get(parsed.data.requestId)
  if (replay) {
    writeJson(response, replay.status, replay.body)
    return
  }
  try {
    const result = dispatchDaemonOperation(service, parsed.data.operation, parsed.data.input)
    const recorded = { status: 200, body: { ok: true, result } satisfies DaemonSuccess }
    remember(recent, parsed.data.requestId, recorded)
    writeJson(response, recorded.status, recorded.body)
  } catch (error) {
    const code = error instanceof KnowledgeServiceError ? error.code : 'INTERNAL_ERROR'
    const message = error instanceof KnowledgeServiceError ? error.message : 'Unexpected service failure'
    const recorded = { status: error instanceof KnowledgeServiceError ? 400 : 500, body: {
      ok: false,
      error: { code, message },
    } satisfies DaemonFailure }
    remember(recent, parsed.data.requestId, recorded)
    writeJson(response, recorded.status, recorded.body)
  }
}

function readBoundedBody(request: IncomingMessage): Promise<{ text: string; tooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let tooLarge = false
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes <= MAX_REQUEST_BYTES) chunks.push(chunk)
      else tooLarge = true
    })
    request.once('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), tooLarge }))
    request.once('error', reject)
  })
}

function remember(
  recent: Map<string, { status: number; body: DaemonSuccess | DaemonFailure }>,
  requestId: string,
  result: { status: number; body: DaemonSuccess | DaemonFailure },
): void {
  recent.set(requestId, result)
  while (recent.size > MAX_RECENT_REQUESTS) {
    const oldest = recent.keys().next().value as string | undefined
    if (oldest === undefined) break
    recent.delete(oldest)
  }
}

function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false
  const supplied = Buffer.from(header.slice(7))
  const expected = Buffer.from(token)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false
  try {
    const hostname = new URL(`http://${host}`).hostname
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  } catch {
    return false
  }
}

function applyHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Content-Security-Policy', "default-src 'none'")
}

function writeFailure(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  writeJson(response, status, { ok: false, error: { code, message } } satisfies DaemonFailure)
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const encoded = Buffer.from(JSON.stringify(body))
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Content-Length', encoded.byteLength)
  response.end(encoded)
}
