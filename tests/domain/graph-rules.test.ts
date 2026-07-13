import { describe, expect, it } from 'vitest'

import {
  assertAcyclic,
  validateRelation,
  type NodeType,
  type RelationType,
} from '../../src/domain/graph-rules.js'

describe('graph rules', () => {
  it.each<{
    source: NodeType
    relation: RelationType
    target: NodeType
  }>([
    { source: 'Attempt', relation: 'ATTEMPTS_TO_SOLVE', target: 'Problem' },
    { source: 'Attempt', relation: 'PRECEDED_BY', target: 'Attempt' },
    { source: 'Attempt', relation: 'FAILED_BECAUSE', target: 'RootCause' },
    { source: 'RootCause', relation: 'CAUSES', target: 'Problem' },
    { source: 'Solution', relation: 'ADDRESSES', target: 'RootCause' },
    { source: 'Solution', relation: 'VERIFIED_BY', target: 'Verification' },
    { source: 'Verification', relation: 'REFERENCES', target: 'Artifact' },
    { source: 'SuccessCase', relation: 'INCLUDES', target: 'Problem' },
    { source: 'SuccessCase', relation: 'INCLUDES', target: 'Attempt' },
    { source: 'SuccessCase', relation: 'INCLUDES', target: 'RootCause' },
    { source: 'SuccessCase', relation: 'INCLUDES', target: 'Solution' },
    { source: 'SuccessCase', relation: 'INCLUDES', target: 'Verification' },
    { source: 'Guardrail', relation: 'PREVENTS', target: 'RootCause' },
    { source: 'Solution', relation: 'SUPERSEDES', target: 'Solution' },
  ])('allows $source --$relation--> $target', ({ source, relation, target }) => {
    expect(() => validateRelation(source, relation, target)).not.toThrow()
  })

  it('rejects a relation with invalid endpoint types', () => {
    expect(() =>
      validateRelation('Problem', 'ATTEMPTS_TO_SOLVE', 'Attempt'),
    ).toThrow(/invalid relation/i)
  })

  it('rejects self-edges and longer directed cycles', () => {
    expect(() => assertAcyclic([{ sourceId: 'a', targetId: 'a' }])).toThrow(
      /cycle/i,
    )
    expect(() =>
      assertAcyclic([
        { sourceId: 'a', targetId: 'b' },
        { sourceId: 'b', targetId: 'c' },
        { sourceId: 'c', targetId: 'a' },
      ]),
    ).toThrow(/cycle/i)
  })

  it('accepts a directed acyclic graph', () => {
    expect(() =>
      assertAcyclic([
        { sourceId: 'a', targetId: 'b' },
        { sourceId: 'a', targetId: 'c' },
        { sourceId: 'c', targetId: 'd' },
      ]),
    ).not.toThrow()
  })
})
