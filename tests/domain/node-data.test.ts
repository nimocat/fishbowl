import { describe, expect, it } from 'vitest'

import { validateNodeData } from '../../src/domain/node-data.js'

describe('node data validation', () => {
  it.each([
    ['Problem', { summary: 'Build failed', symptoms: ['Module missing'], domain: 'build' }],
    [
      'Attempt',
      {
        hypothesis: 'Generated files are stale',
        change: 'Regenerated project',
        outcome: 'failed',
        failureExplanation: 'Module remained missing',
      },
    ],
    [
      'RootCause',
      {
        explanation: 'The package was omitted',
        evidence: ['Resolved package graph omits it'],
        confidence: 0.9,
      },
    ],
    [
      'Solution',
      {
        summary: 'Restore package declaration',
        applicability: ['Package-based builds'],
        limitations: ['Does not repair corrupt caches'],
        decisiveDifference: 'Changed the manifest instead of regenerating files',
      },
    ],
    [
      'Verification',
      {
        kind: 'automated',
        succeeded: true,
        command: ['npm', 'test'],
        exitStatus: 0,
        excerpt: '32 tests passed',
      },
    ],
    ['SuccessCase', { summary: 'Manifest restored and tests passed' }],
    [
      'Guardrail',
      {
        guidance: 'Check the manifest before regenerating',
        enforcement: 'warn',
        criteria: { commandIncludes: ['generate'] },
      },
    ],
    ['Artifact', { kind: 'build-log', uri: 'data/logs/project/run.log', digest: 'abc123' }],
  ] as const)('accepts valid %s data', (type, data) => {
    expect(validateNodeData(type, data)).toEqual({ valid: true, data })
  })

  it.each([
    ['Problem', { summary: '' }],
    ['Attempt', { hypothesis: 'Maybe' }],
    ['RootCause', { explanation: 'Cause', evidence: [], confidence: 2 }],
    ['Solution', { summary: 'Fix', applicability: [], limitations: [] }],
    ['Verification', { kind: 'robot', succeeded: true }],
    ['SuccessCase', {}],
    ['Guardrail', { guidance: 'No criteria', enforcement: 'block', criteria: {} }],
    ['Artifact', { kind: 'log', uri: '' }],
  ] as const)('rejects malformed %s data', (type, data) => {
    const result = validateNodeData(type, data)

    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.issues.length).toBeGreaterThan(0)
      expect(result.issues[0]).toMatchObject({ path: expect.any(String), message: expect.any(String) })
    }
  })

  it.each([
    ['Problem', { summary: 'Failure', symptoms: [1] }],
    [
      'Attempt',
      { hypothesis: 'Cache', change: 'Clear it', outcome: 'failed', command: ['npm', 1] },
    ],
    [
      'RootCause',
      { explanation: 'Cause', evidence: ['log'], confidence: 0.8, rejectedAlternatives: [false] },
    ],
    [
      'Solution',
      {
        summary: 'Fix',
        applicability: ['all'],
        limitations: ['known'],
        decisiveDifference: 'Changed input',
        sideEffects: [null],
      },
    ],
    [
      'Verification',
      { kind: 'automated', succeeded: true, environment: { os: 22 } },
    ],
    ['Artifact', { kind: 'log', uri: '/log', digest: 123 }],
  ] as const)('rejects invalid optional fields for %s', (type, data) => {
    expect(validateNodeData(type, data)).toMatchObject({ valid: false })
  })

  it('allows only explicit non-secret Verification environment facts', () => {
    expect(validateNodeData('Verification', {
      kind: 'automated',
      succeeded: true,
      environment: { os: 'darwin', architecture: 'arm64', toolVersion: '1.2.3' },
    })).toMatchObject({ valid: true })
    expect(validateNodeData('Verification', {
      kind: 'automated',
      succeeded: true,
      environment: { PATH: '/secret/bin', reviewer: 'alice' },
    })).toMatchObject({ valid: false })
  })
})
