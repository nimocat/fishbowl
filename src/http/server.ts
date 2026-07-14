import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import {
  KnowledgeServiceError,
} from '../application/knowledge-service.js'
import type { KnowledgeServiceContract } from '../application/contracts.js'
import type { NodeStatus, NodeType } from '../domain/graph-rules.js'
import { streamKnowledgeEvents } from './sse.js'

const LOOPBACK_ADDRESS = '127.0.0.1'
const MAX_URL_BYTES = 2_048
const MAX_RESPONSE_BYTES = 1_048_576
const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100
const MAX_GRAPH_NODES_PER_CASE = 100
const MAX_GRAPH_EDGES_PER_CASE = 200
const activeStreams = new WeakMap<Server, Set<ServerResponse>>()

export interface TraceBenchServerOptions {
  service: KnowledgeServiceContract
  port?: number
  staticDirectory?: string
  sse?: {
    pollIntervalMs?: number
    heartbeatIntervalMs?: number
    batchSize?: number
  }
}

export interface RunningTraceBenchServer {
  server: Server
  address: AddressInfo
  close(): Promise<void>
}

export async function startTraceBenchServer(
  options: TraceBenchServerOptions,
): Promise<RunningTraceBenchServer> {
  const server = createTraceBenchServer(options)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, LOOPBACK_ADDRESS, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Trace Bench server did not obtain a TCP address')
  }
  return {
    server,
    address,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const response of activeStreams.get(server) ?? []) response.destroy()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

export function createTraceBenchServer(options: TraceBenchServerOptions): Server {
  const streams = new Set<ServerResponse>()
  const server = createServer((request, response) => {
    void routeRequest(request, response, options, streams).catch((error: unknown) => {
      writeError(response, error)
    })
  })
  activeStreams.set(server, streams)
  return server
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: TraceBenchServerOptions,
  streams: Set<ServerResponse>,
): Promise<void> {
  applySecurityHeaders(response)
  const host = request.headers.host
  if (!host || !isLoopbackHost(host)) {
    writeJson(response, 403, { error: 'FORBIDDEN', message: 'Loopback Host required' })
    return
  }
  const origin = request.headers.origin
  if (origin && origin !== `http://${host}`) {
    writeJson(response, 403, { error: 'FORBIDDEN', message: 'Same-origin requests required' })
    return
  }
  if (request.method !== 'GET') {
    writeJson(response, 405, { error: 'METHOD_NOT_ALLOWED', message: 'Read-only GET API' })
    return
  }
  const requestUrl = request.url ?? '/'
  if (Buffer.byteLength(requestUrl) > MAX_URL_BYTES) {
    writeJson(response, 414, { error: 'URI_TOO_LONG', message: 'Request URL is too long' })
    return
  }

  let url: URL
  try {
    url = new URL(requestUrl, `http://${host}`)
  } catch {
    writeJson(response, 400, { error: 'INVALID_ARGUMENT', message: 'Malformed URL' })
    return
  }

  if (url.pathname === '/health') {
    writeJson(response, 200, { status: 'ok' })
    return
  }
  if (url.pathname === '/api/v1/projects') {
    writeJson(response, 200, { projects: options.service.listProjects() })
    return
  }
  if (await serveStaticAsset(url.pathname, response, options.staticDirectory)) {
    return
  }
  if (!url.pathname.startsWith('/api/v1/')) {
    writeJson(response, 404, { error: 'NOT_FOUND', message: 'Route not found' })
    return
  }

  const projectId = requiredProjectId(url)
  const project = { projectId }
  if (url.pathname === '/api/v1/events') {
    if (streams.size >= 32) {
      writeJson(response, 503, { error: 'STREAM_LIMIT', message: 'Too many active event streams' })
      return
    }
    options.service.resolveProject(project)
    const afterHeader = request.headers['last-event-id']
    const after = afterHeader === undefined
      ? nonNegativeInteger(url, 'after', 0)
      : parseCursor(Array.isArray(afterHeader) ? afterHeader[0] : afterHeader)
    streamKnowledgeEvents({
      request,
      response,
      service: options.service,
      projectId,
      afterSequence: after,
      options: options.sse,
    })
    streams.add(response)
    response.once('close', () => streams.delete(response))
    return
  }
  if (url.pathname === '/api/v1/search') {
    const snapshotSequence = asOfSequence(options.service, projectId)
    const result = options.service.queryKnowledge({
      project,
      text: optionalBoundedText(url, 'q'),
      domain: optionalBoundedText(url, 'domain'),
      file: optionalBoundedText(url, 'file'),
      command: optionalBoundedText(url, 'command'),
      fingerprint: optionalBoundedText(url, 'fingerprint'),
      nodeTypes: csvValues(url, 'types') as NodeType[] | undefined,
      statuses: csvValues(url, 'statuses') as NodeStatus[] | undefined,
      limit: queryLimit(url),
    })
    writeBoundedCollection(response, {
      items: result.items,
      limit: result.limit,
      truncated: result.truncated,
      asOfSequence: snapshotSequence,
    }, 'items')
    return
  }
  if (url.pathname === '/api/v1/graph') {
    const snapshotSequence = asOfSequence(options.service, projectId)
    const result = options.service.queryKnowledge({
      project,
      text: optionalBoundedText(url, 'q'),
      domain: optionalBoundedText(url, 'domain'),
      nodeTypes: csvValues(url, 'types') as NodeType[] | undefined,
      statuses: csvValues(url, 'statuses') as NodeStatus[] | undefined,
      limit: queryLimit(url),
    })
    const caseIds = [...new Set(result.items.map((item) => item.caseId))]
    const cases = caseIds.map((caseId) => {
      const detail = options.service.getCase({ project, caseId, detail: 'graph' })
      const nodes = detail.nodes.slice(0, MAX_GRAPH_NODES_PER_CASE)
      const nodeIds = new Set(nodes.map((node) => node.id))
      const edges = detail.edges
        .filter((edge) => nodeIds.has(edge.sourceId) && nodeIds.has(edge.targetId))
        .slice(0, MAX_GRAPH_EDGES_PER_CASE)
      return {
        ...detail,
        nodes,
        edges,
        graphTruncated: nodes.length < detail.nodes.length || edges.length < detail.edges.length,
      }
    })
    writeBoundedCollection(response, {
      projectId,
      cases,
      limit: result.limit,
      truncated: result.truncated,
      asOfSequence: snapshotSequence,
    }, 'cases')
    return
  }
  if (url.pathname === '/api/v1/activity') {
    const snapshotSequence = asOfSequence(options.service, projectId)
    const result = options.service.listRecentActivity({
      project,
      afterSequence: nonNegativeInteger(url, 'after', 0),
      limit: queryLimit(url),
    })
    writeBoundedCollection(response, {
      ...result,
      asOfSequence: snapshotSequence,
    }, 'events')
    return
  }
  const caseMatch = /^\/api\/v1\/cases\/([^/]+)$/.exec(url.pathname)
  if (caseMatch) {
    const snapshotSequence = asOfSequence(options.service, projectId)
    const detail = options.service.getCase({
      project,
      caseId: decodeURIComponent(caseMatch[1] as string),
      detail: 'full',
      historyLimit: Math.min(
        nonNegativeInteger(url, 'history_limit', 50, true),
        MAX_LIMIT,
      ),
      historyBeforeSequence: optionalPositiveInteger(url, 'history_before'),
    })
    writeJson(response, 200, {
      ...detail,
      asOfSequence: snapshotSequence,
    })
    return
  }

  writeJson(response, 404, { error: 'NOT_FOUND', message: 'Route not found' })
}

function requiredProjectId(url: URL): string {
  const projectId = url.searchParams.get('project_id')?.trim()
  if (!projectId || Buffer.byteLength(projectId) > 256) {
    throw new KnowledgeServiceError('INVALID_ARGUMENT', 'project_id is required')
  }
  return projectId
}

function optionalBoundedText(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)?.trim()
  if (!value) return undefined
  if (Buffer.byteLength(value) > 1_024) {
    throw new KnowledgeServiceError('INVALID_ARGUMENT', `${name} is too long`)
  }
  return value
}

function csvValues(url: URL, name: string): string[] | undefined {
  const value = optionalBoundedText(url, name)
  return value ? value.split(',').map((item) => item.trim()).filter(Boolean) : undefined
}

function queryLimit(url: URL): number {
  return Math.min(nonNegativeInteger(url, 'limit', DEFAULT_LIMIT, true), MAX_LIMIT)
}

function nonNegativeInteger(
  url: URL,
  name: string,
  fallback: number,
  positive = false,
): number {
  const raw = url.searchParams.get(name)
  if (raw === null) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    throw new KnowledgeServiceError('INVALID_ARGUMENT', `${name} must be an integer`)
  }
  return value
}

function optionalPositiveInteger(url: URL, name: string): number | undefined {
  if (!url.searchParams.has(name)) return undefined
  return nonNegativeInteger(url, name, 1, true)
}

function parseCursor(raw: string | undefined): number {
  const value = Number(raw)
  if (!raw || !Number.isSafeInteger(value) || value < 0) {
    throw new KnowledgeServiceError('INVALID_ARGUMENT', 'Last-Event-ID must be a non-negative integer')
  }
  return value
}

function asOfSequence(service: KnowledgeServiceContract, projectId: string): number {
  return service.listRecentActivity({
    project: { projectId },
    afterSequence: 0,
    limit: 1,
  }).nextSequence
}

function isLoopbackHost(host: string): boolean {
  try {
    const hostname = new URL(`http://${host}`).hostname
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  } catch {
    return false
  }
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'")
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('Cache-Control', 'no-store')
}

async function serveStaticAsset(
  pathname: string,
  response: ServerResponse,
  staticDirectory: string | undefined,
): Promise<boolean> {
  const assets: Record<string, { file: string; contentType: string }> = {
    '/': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
    '/index.html': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
    '/styles.css': { file: 'styles.css', contentType: 'text/css; charset=utf-8' },
    '/app.js': { file: 'app.js', contentType: 'text/javascript; charset=utf-8' },
  }
  const asset = assets[pathname]
  if (!asset) return false
  const directory = staticDirectory ?? fileURLToPath(new URL('../web/', import.meta.url))
  const body = await readFile(`${directory}/${asset.file}`)
  if (body.byteLength > MAX_RESPONSE_BYTES) {
    writeJson(response, 507, { error: 'RESPONSE_TOO_LARGE', message: 'Static asset exceeds limit' })
    return true
  }
  response.statusCode = 200
  response.setHeader('Content-Type', asset.contentType)
  response.setHeader('Content-Length', body.byteLength)
  response.end(body)
  return true
}

function writeBoundedCollection(
  response: ServerResponse,
  body: Record<string, unknown>,
  collectionKey: string,
): void {
  const collection = body[collectionKey]
  if (!Array.isArray(collection)) {
    writeJson(response, 200, body)
    return
  }
  let selected = collection
  let encoded = JSON.stringify(body)
  while (Buffer.byteLength(encoded) > MAX_RESPONSE_BYTES && selected.length > 0) {
    selected = selected.slice(0, -1)
    encoded = JSON.stringify({ ...body, [collectionKey]: selected, truncated: true })
  }
  if (Buffer.byteLength(encoded) > MAX_RESPONSE_BYTES) {
    writeJson(response, 507, { error: 'RESPONSE_TOO_LARGE', message: 'Snapshot exceeds response limit' })
    return
  }
  writeEncodedJson(response, 200, encoded)
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body)
  if (Buffer.byteLength(encoded) > MAX_RESPONSE_BYTES) {
    writeEncodedJson(response, 507, JSON.stringify({
      error: 'RESPONSE_TOO_LARGE',
      message: 'Response exceeds limit',
    }))
    return
  }
  writeEncodedJson(response, status, encoded)
}

function writeEncodedJson(response: ServerResponse, status: number, encoded: string): void {
  if (response.headersSent) return
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Content-Length', Buffer.byteLength(encoded))
  response.end(encoded)
}

function writeError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end()
    return
  }
  if (error instanceof KnowledgeServiceError) {
    const status = error.code === 'NOT_FOUND' || error.code === 'OWNERSHIP_MISMATCH'
      ? 404
      : error.code === 'PAYLOAD_TOO_LARGE'
        ? 413
        : 400
    writeJson(response, status, { error: error.code, message: error.message })
    return
  }
  if (error instanceof URIError) {
    writeJson(response, 400, { error: 'INVALID_ARGUMENT', message: 'Malformed percent encoding' })
    return
  }
  writeJson(response, 500, { error: 'INTERNAL_ERROR', message: 'Internal server error' })
}
