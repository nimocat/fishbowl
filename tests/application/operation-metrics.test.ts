import { describe, expect, it } from 'vitest'

import { OperationMetrics } from '../../src/application/operation-metrics.js'

describe('OperationMetrics', () => {
  it('keeps a bounded scalar window and returns deterministic aggregates', () => {
    const metrics = new OperationMetrics(1_000)
    for (let index = 1; index <= 1_005; index += 1) {
      metrics.record({
        operation: 'query_knowledge',
        ok: index % 10 !== 0,
        errorCode: index % 10 === 0 ? 'VALIDATION_FAILED' : null,
        durationMs: index,
        responseBytes: index * 2,
        itemCount: 1,
        occurredAt: '2026-07-14T00:00:00.000Z',
      })
    }

    expect(metrics.aggregates()).toEqual([{
      operation: 'query_knowledge',
      count: 1_000,
      errors: 100,
      p50DurationMs: 505,
      p95DurationMs: 955,
      maxDurationMs: 1_005,
      maxResponseBytes: 2_010,
    }])
    expect(JSON.stringify(metrics.aggregates())).not.toMatch(
      /request|responseBody|token=metrics-secret/,
    )
  })

  it('clamps invalid numeric samples without accepting arbitrary content', () => {
    const metrics = new OperationMetrics()
    metrics.record({
      operation: 'get_case',
      ok: true,
      errorCode: null,
      durationMs: Number.NaN,
      responseBytes: -1,
      itemCount: null,
      occurredAt: '2026-07-14T00:00:00.000Z',
    })

    expect(metrics.aggregates()[0]).toMatchObject({
      p50DurationMs: 0,
      maxResponseBytes: 0,
    })

    metrics.record({
      operation: 'get_case',
      ok: true,
      errorCode: null,
      durationMs: 1.6,
      responseBytes: Number.MAX_SAFE_INTEGER + 100,
      itemCount: 1.2,
      occurredAt: '2026-07-14T00:00:00.000Z',
    })
    expect(metrics.aggregates()[0]).toMatchObject({
      maxDurationMs: 2,
      maxResponseBytes: Number.MAX_SAFE_INTEGER,
    })
  })
})
