import {
  AmbiguousProjectReferenceError,
  CaseNotFoundError,
  InvalidGraphError,
  ProjectConflictError,
  ProjectNotFoundError,
} from '../domain/errors.js'

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
  if (error instanceof ProjectNotFoundError || error instanceof CaseNotFoundError) {
    return new KnowledgeServiceError('NOT_FOUND', error.message)
  }
  if (error instanceof AmbiguousProjectReferenceError) {
    return new KnowledgeServiceError('INVALID_ARGUMENT', error.message)
  }
  if (error instanceof ProjectConflictError) {
    return new KnowledgeServiceError('CONFLICT', error.message)
  }
  if (error instanceof InvalidGraphError) {
    return new KnowledgeServiceError('VALIDATION_FAILED', error.message)
  }
  return undefined
}
