import type { NodeType } from './graph-rules.js'

export interface ProblemData {
  summary: string
  symptoms?: string[]
  firstObservedAt?: string
  domain?: string
  fingerprint?: string
}

export interface AttemptData {
  hypothesis: string
  change: string
  outcome: 'failed' | 'succeeded' | 'inconclusive'
  command?: string[]
  failureExplanation?: string
  decisiveDifference?: string
}

export interface RootCauseData {
  explanation: string
  evidence: string[]
  rejectedAlternatives?: string[]
  confidence: number
}

export interface SolutionData {
  summary: string
  applicability: string[]
  limitations: string[]
  sideEffects?: string[]
  decisiveDifference: string
}

export interface VerificationData {
  kind: 'automated' | 'human'
  succeeded: boolean
  humanConfirmed?: boolean
  environment?: Record<string, string>
  command?: string[]
  exitStatus?: number
  sourceRevision?: string
  excerpt?: string
}

export interface SuccessCaseData {
  summary: string
}

export interface GuardrailCriteriaData {
  taskIncludes?: string[]
  commandIncludes?: string[]
  fileIncludes?: string[]
}

export interface GuardrailData {
  guidance: string
  enforcement: 'advise' | 'warn' | 'block'
  criteria: GuardrailCriteriaData
}

export interface ArtifactData {
  kind: string
  uri: string
  digest?: string
  mediaType?: string
}

export interface NodeDataByType {
  Problem: ProblemData
  Attempt: AttemptData
  RootCause: RootCauseData
  Solution: SolutionData
  Verification: VerificationData
  SuccessCase: SuccessCaseData
  Guardrail: GuardrailData
  Artifact: ArtifactData
}

export interface ValidationIssue {
  path: string
  message: string
}

export type ValidationResult<T> =
  | { valid: true; data: T }
  | { valid: false; issues: ValidationIssue[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isStringArray(value: unknown, allowEmpty = true): value is string[] {
  return (
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every(isNonEmptyString)
  )
}

function optionalStringArray(value: unknown): boolean {
  return value === undefined || isStringArray(value)
}

function optionalString(value: unknown): boolean {
  return value === undefined || isNonEmptyString(value)
}

function optionalCommand(value: unknown): boolean {
  return value === undefined || isStringArray(value, false)
}

const VERIFICATION_ENVIRONMENT_KEYS = new Set([
  'os', 'toolVersion', 'architecture', 'scheme', 'destination', 'configuration',
])

function optionalVerificationEnvironment(value: unknown): boolean {
  return value === undefined || (
    isRecord(value) &&
    Object.entries(value).every(([key, entry]) =>
      VERIFICATION_ENVIRONMENT_KEYS.has(key) && typeof entry === 'string')
  )
}

function requiredString(
  data: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[],
): void {
  if (!isNonEmptyString(data[key])) {
    issues.push({ path: key, message: 'must be a non-empty string' })
  }
}

function requiredStringArray(
  data: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[],
): void {
  if (!isStringArray(data[key], false)) {
    issues.push({ path: key, message: 'must contain at least one non-empty string' })
  }
}

function validateCriteria(value: unknown): boolean {
  if (!isRecord(value)) {
    return false
  }
  const fields = [value.taskIncludes, value.commandIncludes, value.fileIncludes]
  return fields.some((field) => isStringArray(field, false)) && fields.every(optionalStringArray)
}

export function validateNodeData<T extends NodeType>(
  type: T,
  input: unknown,
): ValidationResult<NodeDataByType[T]> {
  if (!isRecord(input)) {
    return { valid: false, issues: [{ path: '', message: 'must be an object' }] }
  }

  const issues: ValidationIssue[] = []
  switch (type) {
    case 'Problem':
      requiredString(input, 'summary', issues)
      if (!optionalStringArray(input.symptoms)) {
        issues.push({ path: 'symptoms', message: 'must be an array of non-empty strings' })
      }
      for (const key of ['firstObservedAt', 'domain', 'fingerprint']) {
        if (!optionalString(input[key])) {
          issues.push({ path: key, message: 'must be a non-empty string when provided' })
        }
      }
      break
    case 'Attempt':
      requiredString(input, 'hypothesis', issues)
      requiredString(input, 'change', issues)
      if (!['failed', 'succeeded', 'inconclusive'].includes(input.outcome as string)) {
        issues.push({ path: 'outcome', message: 'must be failed, succeeded, or inconclusive' })
      }
      if (!optionalCommand(input.command)) {
        issues.push({ path: 'command', message: 'must be a non-empty string array when provided' })
      }
      for (const key of ['failureExplanation', 'decisiveDifference']) {
        if (!optionalString(input[key])) {
          issues.push({ path: key, message: 'must be a non-empty string when provided' })
        }
      }
      break
    case 'RootCause':
      requiredString(input, 'explanation', issues)
      requiredStringArray(input, 'evidence', issues)
      if (
        typeof input.confidence !== 'number' ||
        !Number.isFinite(input.confidence) ||
        input.confidence < 0 ||
        input.confidence > 1
      ) {
        issues.push({ path: 'confidence', message: 'must be a number from 0 through 1' })
      }
      if (!optionalStringArray(input.rejectedAlternatives)) {
        issues.push({
          path: 'rejectedAlternatives',
          message: 'must be an array of non-empty strings when provided',
        })
      }
      break
    case 'Solution':
      requiredString(input, 'summary', issues)
      requiredStringArray(input, 'applicability', issues)
      requiredStringArray(input, 'limitations', issues)
      requiredString(input, 'decisiveDifference', issues)
      if (!optionalStringArray(input.sideEffects)) {
        issues.push({
          path: 'sideEffects',
          message: 'must be an array of non-empty strings when provided',
        })
      }
      break
    case 'Verification':
      if (input.kind !== 'automated' && input.kind !== 'human') {
        issues.push({ path: 'kind', message: 'must be automated or human' })
      }
      if (typeof input.succeeded !== 'boolean') {
        issues.push({ path: 'succeeded', message: 'must be a boolean' })
      }
      if (!optionalVerificationEnvironment(input.environment)) {
        issues.push({ path: 'environment', message: 'contains a key outside the verification allowlist' })
      }
      if (input.humanConfirmed !== undefined && typeof input.humanConfirmed !== 'boolean') {
        issues.push({ path: 'humanConfirmed', message: 'must be a boolean when provided' })
      }
      if (!optionalCommand(input.command)) {
        issues.push({ path: 'command', message: 'must be a non-empty string array when provided' })
      }
      if (
        input.exitStatus !== undefined &&
        (typeof input.exitStatus !== 'number' || !Number.isInteger(input.exitStatus))
      ) {
        issues.push({ path: 'exitStatus', message: 'must be an integer when provided' })
      }
      for (const key of ['sourceRevision', 'excerpt']) {
        if (!optionalString(input[key])) {
          issues.push({ path: key, message: 'must be a non-empty string when provided' })
        }
      }
      break
    case 'SuccessCase':
      requiredString(input, 'summary', issues)
      break
    case 'Guardrail':
      requiredString(input, 'guidance', issues)
      if (!['advise', 'warn', 'block'].includes(input.enforcement as string)) {
        issues.push({ path: 'enforcement', message: 'must be advise, warn, or block' })
      }
      if (!validateCriteria(input.criteria)) {
        issues.push({ path: 'criteria', message: 'must contain at least one matching criterion' })
      }
      break
    case 'Artifact':
      requiredString(input, 'kind', issues)
      requiredString(input, 'uri', issues)
      for (const key of ['digest', 'mediaType']) {
        if (!optionalString(input[key])) {
          issues.push({ path: key, message: 'must be a non-empty string when provided' })
        }
      }
      break
  }

  return issues.length > 0
    ? { valid: false, issues }
    : { valid: true, data: input as unknown as NodeDataByType[T] }
}
