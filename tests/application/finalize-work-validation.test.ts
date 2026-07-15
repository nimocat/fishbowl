import { describe, expect, it } from 'vitest'

import {
  normalizeFinalizeVerification,
  validateFinalizeWork,
} from '../../src/application/finalize-work.js'
import type { FinalizeWorkInput } from '../../src/application/contracts.js'

describe('finalize work validation', () => {
  const base: FinalizeWorkInput = {
    project: { projectId: 'project-1' },
    operationId: 'finalize-1',
    task: 'Fix device compile',
    outcome: 'succeeded',
    summary: 'schema-v1 passed',
    commit: { sha: 'abc1234', message: 'fix: keep schema v1' },
    solution: {
      summary: 'Keep schema-v1',
      applicability: ['S1 Pro'],
      limitations: ['schema-v2 unavailable'],
      decisiveDifference: 'Restored schema-v1',
    },
    verifications: [{
      kind: 'automated',
      succeeded: true,
      command: ['npm', 'test'],
      excerpt: 'pass',
    }],
    merge: { status: 'not-required' },
  }

  it('requires commit and successful verification for succeeded work', () => {
    expect(() => validateFinalizeWork({ ...base, commit: undefined }))
      .toThrow(/commit is required/i)
    expect(() => validateFinalizeWork({
      ...base,
      verifications: [{ ...base.verifications![0]!, succeeded: false }],
    })).toThrow(/successful verification/i)
  })

  it.each(['failed', 'inconclusive'] as const)(
    'requires a failed attempt for %s work',
    (outcome) => {
      expect(() => validateFinalizeWork({
        ...base,
        outcome,
        commit: undefined,
        solution: undefined,
        verifications: undefined,
        failedAttempts: [],
      })).toThrow(/failedAttempts/i)
    },
  )

  it('requires a solution when verification is supplied', () => {
    expect(() => validateFinalizeWork({ ...base, solution: undefined }))
      .toThrow(/solution is required/i)
  })

  it('normalizes device evidence to human evidence without auto-confirming it', () => {
    expect(() => normalizeFinalizeVerification({
      kind: 'device',
      succeeded: true,
      excerpt: 'physical device passed',
      environment: {},
    })).toThrow(/destination/i)

    expect(normalizeFinalizeVerification({
      kind: 'device',
      succeeded: true,
      excerpt: 'physical device passed',
      environment: { destination: 'iPhone 17 Pro' },
    })).toEqual({
      kind: 'human',
      succeeded: true,
      excerpt: 'physical device passed',
      environment: { destination: 'iPhone 17 Pro' },
    })
  })

  it('requires argv for automated verification and rejects human confirmation', () => {
    expect(() => normalizeFinalizeVerification({
      kind: 'automated', succeeded: true, excerpt: 'pass',
    })).toThrow(/command/i)
    expect(() => normalizeFinalizeVerification({
      kind: 'automated', succeeded: true, excerpt: 'pass', command: ['npm', 'test'], humanConfirmed: true,
    })).toThrow(/humanConfirmed/i)
  })
})
