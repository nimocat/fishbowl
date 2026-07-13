import { describe, expect, it } from 'vitest'

import {
  evaluateGuardrail,
  evaluatePromotion,
  evaluateRegression,
} from '../../src/domain/policies.js'

describe('promotion policy', () => {
  it('returns every exact missing requirement for mixed verification', () => {
    expect(
      evaluatePromotion({
        rootCauseEvidenceCount: 0,
        successfulAutomatedVerificationCount: 0,
        nonAutomatableReason: null,
        humanVerificationRequired: true,
        humanVerificationPresent: false,
        rootCauseVerified: false,
        humanConfirmed: false,
        applicability: [],
        limitations: [],
        decisiveDifference: '',
      }),
    ).toEqual({
      eligible: false,
      missingRequirements: [
        'root-cause-evidence',
        'verified-root-cause',
        'automated-verification-or-exception',
        'required-human-verification',
        'human-confirmation',
        'applicability',
        'limitations',
        'decisive-difference',
      ],
    })
  })

  it('allows a recorded non-automatable exception and optional human evidence', () => {
    expect(
      evaluatePromotion({
        rootCauseEvidenceCount: 1,
        successfulAutomatedVerificationCount: 0,
        nonAutomatableReason: 'Requires physical hardware',
        humanVerificationRequired: true,
        humanVerificationPresent: true,
        rootCauseVerified: true,
        humanConfirmed: true,
        applicability: ['Device builds'],
        limitations: ['One hardware model'],
        decisiveDifference: 'Validated on the target hardware',
      }),
    ).toEqual({ eligible: true, missingRequirements: [] })
  })
})

describe('regression boundary policy', () => {
  const boundary = {
    platform: ['darwin'],
    configuration: ['debug', 'release'],
  }

  it('regresses only a matching fingerprint inside every applicability dimension', () => {
    expect(
      evaluateRegression({
        fingerprintMatches: true,
        applicabilityBoundary: boundary,
        observedContext: { platform: 'darwin', configuration: 'debug' },
      }),
    ).toBe('regressed')
    expect(
      evaluateRegression({
        fingerprintMatches: true,
        applicabilityBoundary: boundary,
        observedContext: { platform: 'linux', configuration: 'debug' },
      }),
    ).toBe('outside-applicability')
    expect(
      evaluateRegression({
        fingerprintMatches: false,
        applicabilityBoundary: boundary,
        observedContext: { platform: 'darwin', configuration: 'debug' },
      }),
    ).toBe('different-fingerprint')
  })

  it('does not claim a regression without a declared boundary', () => {
    expect(
      evaluateRegression({
        fingerprintMatches: true,
        applicabilityBoundary: {},
        observedContext: { platform: 'darwin' },
      }),
    ).toBe('outside-applicability')
  })
})

describe('guardrail policy', () => {
  const context = {
    taskDescription: 'Regenerate the Xcode project',
    command: ['tuist', 'generate'],
    changedFiles: ['Project.swift'],
  }
  const criteria = {
    taskIncludes: ['regenerate'],
    commandIncludes: ['tuist generate'],
    fileIncludes: ['Project.swift'],
  }

  it.each([
    ['candidate', 'block', false],
    ['verified', 'warn', false],
    ['verified', 'block', true],
  ] as const)('matches but blocks only %s + %s', (status, enforcement, blocks) => {
    expect(evaluateGuardrail({ status, enforcement, criteria }, context)).toEqual({
      matches: true,
      blocks,
    })
  })

  it('does not block when any populated criterion misses', () => {
    expect(
      evaluateGuardrail(
        {
          status: 'verified',
          enforcement: 'block',
          criteria: { ...criteria, fileIncludes: ['Package.swift'] },
        },
        context,
      ),
    ).toEqual({ matches: false, blocks: false })
  })
})
