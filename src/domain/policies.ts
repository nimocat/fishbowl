import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import type { NodeStatus } from './graph-rules.js'

export const DEFAULT_PAYLOAD_LIMIT_BYTES = 64 * 1024

export type PromotionRequirement =
  | 'root-cause-evidence'
  | 'verified-root-cause'
  | 'automated-verification-or-exception'
  | 'required-human-verification'
  | 'human-confirmation'
  | 'applicability'
  | 'limitations'
  | 'decisive-difference'

export interface PromotionEvidence {
  rootCauseEvidenceCount: number
  rootCauseVerified: boolean
  successfulAutomatedVerificationCount: number
  nonAutomatableReason: string | null
  humanVerificationRequired: boolean
  humanVerificationPresent: boolean
  humanConfirmed: boolean
  applicability: readonly string[]
  limitations: readonly string[]
  decisiveDifference: string
}

export function evaluatePromotion(input: PromotionEvidence): {
  eligible: boolean
  missingRequirements: PromotionRequirement[]
} {
  const missingRequirements: PromotionRequirement[] = []
  if (input.rootCauseEvidenceCount < 1) {
    missingRequirements.push('root-cause-evidence')
  }
  if (!input.rootCauseVerified) {
    missingRequirements.push('verified-root-cause')
  }
  if (
    input.successfulAutomatedVerificationCount < 1 &&
    !input.nonAutomatableReason?.trim()
  ) {
    missingRequirements.push('automated-verification-or-exception')
  }
  if (input.humanVerificationRequired && !input.humanVerificationPresent) {
    missingRequirements.push('required-human-verification')
  }
  if (!input.humanConfirmed) {
    missingRequirements.push('human-confirmation')
  }
  if (!input.applicability.some((value) => value.trim().length > 0)) {
    missingRequirements.push('applicability')
  }
  if (!input.limitations.some((value) => value.trim().length > 0)) {
    missingRequirements.push('limitations')
  }
  if (!input.decisiveDifference.trim()) {
    missingRequirements.push('decisive-difference')
  }
  return { eligible: missingRequirements.length === 0, missingRequirements }
}

export type ApplicabilityBoundary = Readonly<Record<string, readonly string[]>>

export function evaluateRegression(input: {
  fingerprintMatches: boolean
  applicabilityBoundary: ApplicabilityBoundary
  observedContext: Readonly<Record<string, string>>
}): 'regressed' | 'outside-applicability' | 'different-fingerprint' {
  if (!input.fingerprintMatches) {
    return 'different-fingerprint'
  }
  const boundaryEntries = Object.entries(input.applicabilityBoundary)
  const insideBoundary = boundaryEntries.length > 0 && boundaryEntries.every(
    ([dimension, allowedValues]) => {
      const observed = input.observedContext[dimension]
      return allowedValues.length > 0 && observed !== undefined && allowedValues.includes(observed)
    },
  )
  return insideBoundary ? 'regressed' : 'outside-applicability'
}

export interface GuardrailCriteria {
  taskIncludes?: readonly string[]
  commandIncludes?: readonly string[]
  fileIncludes?: readonly string[]
}

export interface GuardrailContext {
  taskDescription: string
  command: readonly string[]
  changedFiles: readonly string[]
}

function includesAll(haystack: string, needles: readonly string[]): boolean {
  const normalized = haystack.toLocaleLowerCase()
  return needles.every((needle) => normalized.includes(needle.toLocaleLowerCase()))
}

export function evaluateGuardrail(
  guardrail: {
    status: NodeStatus
    enforcement: 'advise' | 'warn' | 'block'
    criteria: GuardrailCriteria
  },
  context: GuardrailContext,
): { matches: boolean; blocks: boolean } {
  const checks: boolean[] = []
  if (guardrail.criteria.taskIncludes?.length) {
    checks.push(includesAll(context.taskDescription, guardrail.criteria.taskIncludes))
  }
  if (guardrail.criteria.commandIncludes?.length) {
    checks.push(includesAll(context.command.join(' '), guardrail.criteria.commandIncludes))
  }
  if (guardrail.criteria.fileIncludes?.length) {
    checks.push(includesAll(context.changedFiles.join('\n'), guardrail.criteria.fileIncludes))
  }
  const matches = checks.length > 0 && checks.every(Boolean)
  return {
    matches,
    blocks: matches && guardrail.status === 'verified' && guardrail.enforcement === 'block',
  }
}

export function canonicalizePath(path: string): string {
  const missingSegments: string[] = []
  let existingPath = resolve(path)
  while (!existsSync(existingPath)) {
    const parent = dirname(existingPath)
    if (parent === existingPath) {
      return resolve(path)
    }
    missingSegments.unshift(existingPath.slice(parent.length + 1))
    existingPath = parent
  }
  return join(realpathSync(existingPath), ...missingSegments)
}

export function isPathWithinBoundary(
  candidate: string,
  allowedRoots: readonly string[],
): boolean {
  if (!isAbsolute(candidate)) {
    return false
  }
  const resolvedCandidate = canonicalizePath(candidate)
  return allowedRoots.some((root) => {
    if (!isAbsolute(root)) {
      return false
    }
    const relation = relative(canonicalizePath(root), resolvedCandidate)
    return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation))
  })
}

export function payloadByteLength(payload: unknown): number {
  const serialized = JSON.stringify(payload)
  if (serialized === undefined) {
    throw new TypeError('Payload must be JSON serializable')
  }
  return Buffer.byteLength(serialized, 'utf8')
}

export function validatePayloadSize(
  payload: unknown,
  limitBytes = DEFAULT_PAYLOAD_LIMIT_BYTES,
): { valid: boolean; byteLength: number; limitBytes: number } {
  const byteLength = payloadByteLength(payload)
  return { valid: byteLength <= limitBytes, byteLength, limitBytes }
}
