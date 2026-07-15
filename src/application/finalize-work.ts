import type {
  FinalizeVerificationInput,
  FinalizeWorkInput,
} from './contracts.js'
import type { VerificationData } from '../domain/node-data.js'
import { KnowledgeServiceError } from './errors.js'

function validationFailure(message: string): never {
  throw new KnowledgeServiceError('VALIDATION_FAILED', message)
}

export function normalizeFinalizeVerification(input: FinalizeVerificationInput): VerificationData {
  if (input.kind === 'automated' && !input.command?.length) {
    validationFailure('automated verification requires command')
  }
  if (input.kind === 'device' && !input.environment?.destination?.trim()) {
    validationFailure('device verification requires environment.destination')
  }
  if (input.kind === 'automated' && input.humanConfirmed !== undefined) {
    validationFailure('automated verification cannot set humanConfirmed')
  }

  return {
    kind: input.kind === 'automated' ? 'automated' : 'human',
    succeeded: input.succeeded,
    excerpt: input.excerpt,
    ...(input.command !== undefined && { command: input.command }),
    ...(input.environment !== undefined && {
      environment: Object.fromEntries(
        Object.entries(input.environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
    }),
    ...(input.humanConfirmed === true && { humanConfirmed: true }),
  }
}

export function validateFinalizeWork(input: FinalizeWorkInput): void {
  if (input.outcome === 'succeeded') {
    if (!input.commit) validationFailure('commit is required for succeeded work')
    if (!input.verifications?.some((verification) => verification.succeeded)) {
      validationFailure('at least one successful verification is required for succeeded work')
    }
  } else if (!input.failedAttempts?.length) {
    validationFailure(`failedAttempts must contain at least one failed attempt for ${input.outcome} work`)
  }

  if (input.verifications?.length && !input.solution) {
    validationFailure('solution is required when verifications are supplied')
  }

  for (const verification of input.verifications ?? []) {
    normalizeFinalizeVerification(verification)
  }
}
