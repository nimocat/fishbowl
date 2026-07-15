import { createHash } from 'node:crypto'

export class PreflightCache<T> {
  private readonly entries = new Map<string, T>()

  constructor(private readonly capacity = 256) {}

  key(projectId: string, revision: number, context: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify([projectId, revision, context]))
      .digest('hex')
  }

  get(key: string): T | undefined {
    const value = this.entries.get(key)
    if (value === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, value)
    return structuredClone(value)
  }

  set(key: string, value: T): void {
    this.entries.delete(key)
    this.entries.set(key, structuredClone(value))
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }
}
