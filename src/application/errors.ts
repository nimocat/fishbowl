export type KnowledgeServiceErrorCode =
  | 'INVALID_ARGUMENT'
  | 'VALIDATION_FAILED'
  | 'PAYLOAD_TOO_LARGE'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'OWNERSHIP_MISMATCH'
  | 'OPERATION_CONFLICT'
  | 'PATH_OUTSIDE_PROJECT'

export class KnowledgeServiceError extends Error {
  constructor(
    public readonly code: KnowledgeServiceErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'KnowledgeServiceError'
  }
}

export function normalizeKnowledgeServiceError(error: unknown): KnowledgeServiceError | undefined {
  if (error instanceof KnowledgeServiceError) return error
  return undefined
}
