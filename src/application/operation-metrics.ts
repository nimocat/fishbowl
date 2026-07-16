export interface OperationMetricSample {
  operation: string
  ok: boolean
  errorCode: string | null
  durationMs: number
  responseBytes: number
  itemCount: number | null
  occurredAt: string
  daemonQueueMs?: number
  daemonExecutionMs?: number
  daemonSerializationMs?: number
  transportMs?: number
  mcpHostMs?: number
}

export interface OperationMetricAggregate {
  operation: string
  count: number
  errors: number
  p50DurationMs: number
  p95DurationMs: number
  maxDurationMs: number
  maxResponseBytes: number
  p95DaemonQueueMs: number
  p95DaemonExecutionMs: number
  p95DaemonSerializationMs: number
  p95TransportMs: number
  p95McpHostMs: number
}

interface StoredMetric {
  operation: string
  ok: boolean
  errorCode: string | null
  durationMs: number
  responseBytes: number
  itemCount: number | null
  occurredAt: string
  daemonQueueMs: number
  daemonExecutionMs: number
  daemonSerializationMs: number
  transportMs: number
  mcpHostMs: number
}

function nonNegativeSafeInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(Number.MAX_SAFE_INTEGER, Math.round(value))
}

function percentile(sorted: number[], ratio: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0
}

export class OperationMetrics {
  private readonly samples: StoredMetric[] = []

  constructor(private readonly capacity = 1_000) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('Operation metric capacity must be a positive integer')
    }
  }

  record(sample: OperationMetricSample): void {
    this.samples.push({
      operation: sample.operation.slice(0, 100),
      ok: sample.ok,
      errorCode: sample.errorCode?.slice(0, 100) ?? null,
      durationMs: nonNegativeSafeInteger(sample.durationMs),
      responseBytes: nonNegativeSafeInteger(sample.responseBytes),
      itemCount: sample.itemCount === null ? null : nonNegativeSafeInteger(sample.itemCount),
      occurredAt: sample.occurredAt.slice(0, 40),
      daemonQueueMs: nonNegativeSafeInteger(sample.daemonQueueMs ?? 0),
      daemonExecutionMs: nonNegativeSafeInteger(sample.daemonExecutionMs ?? 0),
      daemonSerializationMs: nonNegativeSafeInteger(sample.daemonSerializationMs ?? 0),
      transportMs: nonNegativeSafeInteger(sample.transportMs ?? 0),
      mcpHostMs: nonNegativeSafeInteger(sample.mcpHostMs ?? 0),
    })
    if (this.samples.length > this.capacity) {
      this.samples.splice(0, this.samples.length - this.capacity)
    }
  }

  aggregates(): OperationMetricAggregate[] {
    const grouped = new Map<string, StoredMetric[]>()
    for (const sample of this.samples) {
      const group = grouped.get(sample.operation) ?? []
      group.push(sample)
      grouped.set(sample.operation, group)
    }
    return [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([operation, samples]) => {
        const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b)
        return {
          operation,
          count: samples.length,
          errors: samples.filter((sample) => !sample.ok).length,
          p50DurationMs: percentile(durations, 0.5),
          p95DurationMs: percentile(durations, 0.95),
          maxDurationMs: durations.at(-1) ?? 0,
          maxResponseBytes: Math.max(0, ...samples.map((sample) => sample.responseBytes)),
          p95DaemonQueueMs: percentile(samples.map((sample) => sample.daemonQueueMs).sort((a, b) => a - b), 0.95),
          p95DaemonExecutionMs: percentile(samples.map((sample) => sample.daemonExecutionMs).sort((a, b) => a - b), 0.95),
          p95DaemonSerializationMs: percentile(samples.map((sample) => sample.daemonSerializationMs).sort((a, b) => a - b), 0.95),
          p95TransportMs: percentile(samples.map((sample) => sample.transportMs).sort((a, b) => a - b), 0.95),
          p95McpHostMs: percentile(samples.map((sample) => sample.mcpHostMs).sort((a, b) => a - b), 0.95),
        }
      })
  }
}
