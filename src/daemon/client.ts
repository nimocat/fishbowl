import { randomUUID } from 'node:crypto'
import { request } from 'node:http'

import type { AwaitableKnowledgeBackend } from '../application/backend.js'
import type { KnowledgeServiceContract } from '../application/contracts.js'
import { DAEMON_PROTOCOL_VERSION, type DaemonDescriptor } from './config.js'
import type { DaemonFailure, DaemonOperation, DaemonSuccess } from './protocol.js'

export class DaemonClientError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'DaemonClientError'
  }
}

export interface DaemonClientOptions {
  descriptor: DaemonDescriptor
  token: string
  timeoutMs?: number
  startInstalledService?: () => void | Promise<void>
  observeRequestId?: (requestId: string) => void
  afterResponse?: () => void | Promise<void>
}

export class DaemonClient {
  constructor(private readonly options: DaemonClientOptions) {
    if (options.descriptor.protocolVersion !== DAEMON_PROTOCOL_VERSION) {
      throw new DaemonClientError('PROTOCOL_MISMATCH', 'EKG daemon protocol mismatch; reinstall or restart EKG')
    }
  }

  async call<T = unknown>(
    operation: DaemonOperation,
    input: unknown,
    options: { requestId?: string } = {},
  ): Promise<T> {
    const requestId = options.requestId ?? randomUUID()
    let started = false
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.options.observeRequestId?.(requestId)
      try {
        const result = await this.request<T>(operation, input, requestId)
        await this.options.afterResponse?.()
        return result
      } catch (error) {
        if (error instanceof DaemonClientError && error.code !== 'DAEMON_UNAVAILABLE') throw error
        if (attempt === 0 && !started && this.options.startInstalledService) {
          started = true
          await this.options.startInstalledService()
        }
      }
    }
    throw new DaemonClientError(
      'DAEMON_UNAVAILABLE',
      'EKG daemon is unavailable after one retry. Run `ekg doctor` for diagnostics.',
    )
  }

  private request<T>(operation: DaemonOperation, input: unknown, requestId: string): Promise<T> {
    const body = Buffer.from(JSON.stringify({
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      requestId,
      operation,
      input,
    }))
    return new Promise<T>((resolve, reject) => {
      const outgoing = request({
        host: this.options.descriptor.host,
        port: this.options.descriptor.port,
        path: '/rpc',
        method: 'POST',
        headers: {
          Host: `${this.options.descriptor.host}:${this.options.descriptor.port}`,
          Authorization: `Bearer ${this.options.token}`,
          'Content-Type': 'application/json',
          'Content-Length': body.byteLength,
        },
        timeout: this.options.timeoutMs ?? 1_500,
      }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.once('end', () => {
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as DaemonSuccess | DaemonFailure
            if (!payload.ok) {
              reject(new DaemonClientError(payload.error.code, payload.error.message))
              return
            }
            resolve(payload.result as T)
          } catch {
            reject(new DaemonClientError('INVALID_RESPONSE', 'EKG daemon returned an invalid response'))
          }
        })
      })
      outgoing.once('timeout', () => outgoing.destroy(new Error('request timeout')))
      outgoing.once('error', () => reject(new DaemonClientError('DAEMON_UNAVAILABLE', 'EKG daemon connection failed')))
      outgoing.end(body)
    })
  }
}

type UnaryMethod = (input: never) => Promise<unknown>

export function createDaemonBackend(client: DaemonClient): AwaitableKnowledgeBackend {
  const backend: Record<string, UnaryMethod> = {}
  const operations: DaemonOperation[] = [
    'registerProject', 'resolveProject', 'updateProject', 'queryKnowledge', 'getCase',
    'listRecentActivity', 'preflight', 'recordProblem', 'recordAttempt', 'recordRootCause',
    'recordSolution', 'recordVerification', 'recordArtifactReference', 'recordGuardrail',
    'recordCheckpoint', 'checkpointWork', 'reportRelevance', 'suggestCaseMerges', 'applyCaseMerge',
    'recordCommandStarted', 'recordCommandResult', 'closeCase',
    'markRegression', 'previewImport', 'applyImport', 'exportProjectGraph', 'importProjectGraph',
  ]
  for (const operation of operations) {
    backend[operation] = (input: never) => client.call(operation, input)
  }
  backend.listProjects = () => client.call('listProjects', {})
  return backend as unknown as AwaitableKnowledgeBackend
}

export type DaemonKnowledgeBackend = AwaitableKnowledgeBackend & Partial<KnowledgeServiceContract>
