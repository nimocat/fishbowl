import type { IncomingMessage, ServerResponse } from 'node:http'

import type { KnowledgeServiceContract } from '../application/contracts.js'

const DEFAULT_POLL_INTERVAL_MS = 500
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000
const DEFAULT_BATCH_SIZE = 100

export interface SseOptions {
  pollIntervalMs?: number
  heartbeatIntervalMs?: number
  batchSize?: number
}

export function streamKnowledgeEvents(input: {
  request: IncomingMessage
  response: ServerResponse
  service: KnowledgeServiceContract
  projectId: string
  afterSequence: number
  options?: SseOptions
}): void {
  const { request, response, service, projectId } = input
  const pollIntervalMs = boundedInterval(input.options?.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS)
  const heartbeatIntervalMs = boundedInterval(
    input.options?.heartbeatIntervalMs,
    DEFAULT_HEARTBEAT_INTERVAL_MS,
  )
  const batchSize = Math.max(1, Math.min(input.options?.batchSize ?? DEFAULT_BATCH_SIZE, 100))
  let cursor = input.afterSequence
  let closed = false
  let polling = false

  response.statusCode = 200
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  response.setHeader('Connection', 'keep-alive')
  response.setHeader('X-Accel-Buffering', 'no')
  response.flushHeaders()

  const close = () => {
    if (closed) return
    closed = true
    clearInterval(pollTimer)
    clearInterval(heartbeatTimer)
  }

  const poll = () => {
    if (closed || polling) return
    polling = true
    try {
      const result = service.listRecentActivity({
        project: { projectId },
        afterSequence: cursor,
        limit: batchSize,
      })
      if (result.truncated) {
        cursor = result.nextSequence
        if (!writeEvent(response, {
          id: cursor,
          event: 'snapshot_required',
          data: { projectId, reason: 'cursor_gap', asOfSequence: cursor },
        })) {
          response.end()
          close()
        }
        return
      }
      for (const event of result.events) {
        if (event.sequence <= cursor) continue
        cursor = event.sequence
        if (!writeEvent(response, {
          id: event.sequence,
          event: 'knowledge_event',
          data: event,
        })) {
          response.end()
          close()
          return
        }
      }
    } catch {
      writeEvent(response, {
        event: 'stream_error',
        data: { projectId, message: 'Event stream read failed' },
      })
      response.end()
      close()
    } finally {
      polling = false
    }
  }

  const pollTimer = setInterval(poll, pollIntervalMs)
  const heartbeatTimer = setInterval(() => {
    if (!closed && !response.write(': heartbeat\n\n')) {
      response.end()
      close()
    }
  }, heartbeatIntervalMs)
  request.once('close', close)
  response.once('close', close)
  poll()
}

function boundedInterval(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(5, Math.floor(value))
}

function writeEvent(
  response: ServerResponse,
  event: { id?: number; event: string; data: unknown },
): boolean {
  let writable = true
  if (event.id !== undefined) writable = response.write(`id: ${event.id}\n`) && writable
  writable = response.write(`event: ${event.event}\n`) && writable
  return response.write(`data: ${JSON.stringify(event.data)}\n\n`) && writable
}
