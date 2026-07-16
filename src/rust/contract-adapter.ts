import { z } from 'zod'

const protocolVersion = 1 as const
const projectReferenceSchema = z.object({
  projectId: z.string().min(1).max(4096).optional(),
  projectRoot: z.string().min(1).max(4096).optional(),
}).strict().refine(
  (value) => Number(value.projectId !== undefined) + Number(value.projectRoot !== undefined) === 1,
)
const nodeTypeSchema = z.enum([
  'Problem', 'Attempt', 'RootCause', 'Solution', 'Verification', 'SuccessCase', 'Guardrail', 'Artifact',
])
const nodeStatusSchema = z.enum(['open', 'candidate', 'verified', 'regressed', 'retired'])
const boundedText = z.string().min(1).max(16_384)

const queryInputSchema = z.object({
  project: projectReferenceSchema,
  text: boundedText.optional(),
  domain: boundedText.optional(),
  nodeTypes: z.array(nodeTypeSchema).max(100).optional(),
  statuses: z.array(nodeStatusSchema).max(100).optional(),
  file: boundedText.optional(),
  command: boundedText.optional(),
  fingerprint: boundedText.optional(),
  limit: z.number().int().min(1).max(1000).optional(),
}).strict()

const preflightInputSchema = z.object({
  project: projectReferenceSchema,
  taskDescription: boundedText,
  changedFiles: z.array(boundedText).max(100).optional(),
  command: z.array(boundedText).max(100).optional(),
  fingerprint: boundedText.optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  detail: z.enum(['brief', 'standard', 'full']).optional(),
}).strict()

const getCaseInputSchema = z.object({
  project: projectReferenceSchema,
  caseId: z.string().min(1).max(4096),
  detail: z.enum(['summary', 'graph', 'full']).optional(),
  historyLimit: z.number().int().min(1).max(1000).optional(),
  historyBeforeSequence: z.number().int().nonnegative().optional(),
}).strict()

const requestSchema = z.discriminatedUnion('operation', [
  z.object({
    protocolVersion: z.literal(protocolVersion),
    requestId: z.string().min(1).max(200),
    operation: z.literal('queryKnowledge'),
    input: queryInputSchema,
  }).strict(),
  z.object({
    protocolVersion: z.literal(protocolVersion),
    requestId: z.string().min(1).max(200),
    operation: z.literal('preflight'),
    input: preflightInputSchema,
  }).strict(),
  z.object({
    protocolVersion: z.literal(protocolVersion),
    requestId: z.string().min(1).max(200),
    operation: z.literal('getCase'),
    input: getCaseInputSchema,
  }).strict(),
])

const successSchema = z.object({
  ok: z.literal(true),
  requestId: z.string().min(1).max(200),
  result: z.unknown(),
}).strict()

export type RustReadRequest = z.infer<typeof requestSchema>

export interface RustSuccess<T = unknown> {
  ok: true
  requestId: string
  result: T
}

export function encodeRustReadRequest(value: unknown): RustReadRequest {
  const parsed = requestSchema.safeParse(value)
  if (!parsed.success) throw new Error('Invalid Rust daemon request contract')
  return parsed.data
}

export function decodeRustSuccess<T = unknown>(value: unknown): RustSuccess<T> {
  const parsed = successSchema.safeParse(value)
  if (!parsed.success) throw new Error('Invalid Rust daemon success contract')
  return parsed.data as RustSuccess<T>
}
