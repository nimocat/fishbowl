import { z } from 'zod'

import { DAEMON_PROTOCOL_VERSION } from './config.js'

export const DAEMON_OPERATIONS = [
  'registerProject',
  'listProjects',
  'resolveProject',
  'updateProject',
  'queryKnowledge',
  'getCase',
  'listRecentActivity',
  'preflight',
  'recordProblem',
  'recordAttempt',
  'recordRootCause',
  'recordSolution',
  'recordVerification',
  'recordArtifactReference',
  'recordGuardrail',
  'recordCheckpoint',
  'recordCommandStarted',
  'recordCommandResult',
  'closeCase',
  'markRegression',
  'previewImport',
  'applyImport',
  'exportProjectGraph',
  'importProjectGraph',
] as const

export type DaemonOperation = typeof DAEMON_OPERATIONS[number]

export interface DaemonRequest {
  protocolVersion: number
  requestId: string
  operation: DaemonOperation
  input: unknown
}

export interface DaemonSuccess {
  ok: true
  result: unknown
}

export interface DaemonFailure {
  ok: false
  error: { code: string; message: string }
}

export const daemonRequestSchema = z.object({
  protocolVersion: z.number().int(),
  requestId: z.string().min(1).max(200),
  operation: z.enum(DAEMON_OPERATIONS),
  input: z.unknown(),
}).strict()

export function protocolMismatch(value: number): boolean {
  return value !== DAEMON_PROTOCOL_VERSION
}
