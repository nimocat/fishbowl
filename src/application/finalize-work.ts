import type {
  FinalizeVerificationInput,
  FinalizeWorkInput,
} from './contracts.js'
import type { VerificationData } from '../domain/node-data.js'
import { validateNodeData, type ValidationIssue } from '../domain/node-data.js'
import { KnowledgeServiceError } from './errors.js'

function validationFailure(message: string): never {
  throw new KnowledgeServiceError('VALIDATION_FAILED', message)
}

export interface FinalizeValidationIssue extends ValidationIssue {}

function prefixedIssues(prefix: string, issues: ValidationIssue[]): FinalizeValidationIssue[] {
  return issues.map((issue) => ({
    path: issue.path ? `${prefix}.${issue.path}` : prefix,
    message: issue.message,
  }))
}

export function collectFinalizeWorkIssues(input: FinalizeWorkInput): FinalizeValidationIssue[] {
  const issues: FinalizeValidationIssue[] = []
  const add = (path: string, message: string): void => { issues.push({ path, message }) }

  if (input.outcome === 'succeeded') {
    if (!input.commit) add('commit', 'is required for succeeded work')
    if (!input.verifications?.some((verification) => verification.succeeded)) {
      add('verifications', 'must contain at least one successful verification for succeeded work')
    }
  } else if (!input.failedAttempts?.length) {
    add('failedAttempts', `must contain at least one failed attempt for ${input.outcome} work`)
  }

  if (input.verifications?.length && !input.solution) {
    add('solution', 'is required when verifications are supplied')
  }
  if (input.solution && !input.rootCause) {
    add('rootCause', 'is required when solution is supplied')
  }
  if (input.rootCause) {
    const result = validateNodeData('RootCause', input.rootCause)
    if (!result.valid) issues.push(...prefixedIssues('rootCause', result.issues))
  }
  if (input.solution) {
    const result = validateNodeData('Solution', input.solution)
    if (!result.valid) issues.push(...prefixedIssues('solution', result.issues))
  }
  for (const [index, verification] of (input.verifications ?? []).entries()) {
    const prefix = `verifications.${index}`
    if (verification.kind === 'automated' && !verification.command?.length) {
      add(`${prefix}.command`, 'is required for automated verification')
    }
    if (verification.kind === 'device' && !verification.environment?.destination?.trim()) {
      add(`${prefix}.environment.destination`, 'is required for device verification')
    }
    if (verification.kind === 'automated' && verification.humanConfirmed !== undefined) {
      add(`${prefix}.humanConfirmed`, 'cannot be set for automated verification')
    }
  }
  return issues
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
  const issues = collectFinalizeWorkIssues(input)
  if (issues.length === 0) return
  throw new KnowledgeServiceError(
    'VALIDATION_FAILED',
    `Finalize work validation failed: ${issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`,
    { issues },
  )
}
