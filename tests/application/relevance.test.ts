import { describe, expect, it } from 'vitest'

import { compactPreflight, rankCases, type RelevanceCandidate } from '../../src/application/relevance.js'

function candidate(overrides: Partial<RelevanceCandidate>): RelevanceCandidate {
  return {
    caseId: 'case-1',
    caseTitle: 'Schema compatibility',
    caseStatus: 'open',
    nodes: [],
    guardrails: [],
    ...overrides,
  }
}

describe('Case-level relevance', () => {
  it('prioritizes exact fingerprint, file, and verified knowledge with explanations', () => {
    const ranked = rankCases({
      taskDescription: 'Keep schema-v1 and verify CoreML Metal',
      changedFiles: ['S1ProFeatureFrontend.swift'],
      command: ['xcodebuild', 'test'],
      fingerprintCaseIds: ['fingerprint-case'],
    }, [
      candidate({ caseId: 'generic', caseTitle: 'Generic build task' }),
      candidate({ caseId: 'file-case', nodes: [{ id: 'n1', caseId: 'file-case', type: 'Solution', status: 'verified', createdAt: '2026-07-01T00:00:00Z', data: { summary: 'Keep schema-v1', files: ['S1ProFeatureFrontend.swift'] } }] }),
      candidate({ caseId: 'fingerprint-case', nodes: [{ id: 'n2', caseId: 'fingerprint-case', type: 'Problem', status: 'open', createdAt: '2026-07-01T00:00:00Z', data: { summary: 'unrelated' } }] }),
    ], new Date('2026-07-15T00:00:00Z'))

    expect(ranked[0]?.caseId).toBe('fingerprint-case')
    expect(ranked[1]?.whyMatched).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'exact-file' }),
      expect.objectContaining({ kind: 'verified-knowledge' }),
    ]))
    expect(ranked.some((item) => item.caseId === 'generic')).toBe(false)
  })

  it('keeps a bounded five-card response below 12 KiB', () => {
    const cards = Array.from({ length: 20 }, (_, index) => ({
      caseId: `case-${index}`,
      caseTitle: `Relevant case ${index}`,
      score: 100 - index,
      whyMatched: [{ kind: 'text' as const, value: 'relevant' }],
      failedAttempt: { id: `node-${index}`, caseId: `case-${index}`, type: 'Attempt' as const, status: 'candidate' as const, createdAt: '2026-07-01T00:00:00Z', data: { failureExplanation: 'x'.repeat(4_000) } },
    }))
    const result = compactPreflight({ blocked: false, cards, guardrails: [], failedAttempts: [], rootCauses: [], solutions: [], uncertain: [] })

    expect(result.cards.length).toBeLessThanOrEqual(5)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(12 * 1024)
    expect(result.truncated).toBe(true)
  })
})
