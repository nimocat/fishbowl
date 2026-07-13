import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fchmodSync,
  chmodSync,
  fsyncSync,
  mkdirSync,
  lstatSync,
  openSync,
  readdirSync,
  statSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'

const DEFAULT_MAX_SEGMENT_BYTES = 10 * 1024 * 1024
const DEFAULT_MAX_PROJECT_BYTES = 100 * 1024 * 1024
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000
const DEFAULT_MAX_SESSION_BYTES = 100 * 1024 * 1024

export interface RawLogStoreOptions {
  maxSegmentBytes?: number
  maxProjectBytes?: number
  maxAgeMs?: number
  maxSessionBytes?: number
  now?: () => Date
}

export interface RawLogArtifactMetadata {
  kind: 'command-log'
  digestAlgorithm: 'sha256'
  digest: string
  byteSize: number
  retainedByteSize: number
  paths: string[]
  segmentCount: number
  truncated: boolean
}

export interface RawLogResult {
  digest: string
  byteSize: number
  paths: string[]
  artifact: RawLogArtifactMetadata
  truncated: boolean
}

interface Segment {
  descriptor: number
  path: string
  byteSize: number
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

export class RawLogStore {
  private readonly maxSegmentBytes: number
  private readonly maxProjectBytes: number
  private readonly maxAgeMs: number
  private readonly maxSessionBytes: number
  private readonly now: () => Date

  constructor(
    private readonly dataDirectory: string,
    options: RawLogStoreOptions = {},
  ) {
    this.maxSegmentBytes = positiveInteger(
      options.maxSegmentBytes ?? DEFAULT_MAX_SEGMENT_BYTES,
      'maxSegmentBytes',
    )
    this.maxProjectBytes = positiveInteger(
      options.maxProjectBytes ?? DEFAULT_MAX_PROJECT_BYTES,
      'maxProjectBytes',
    )
    this.maxAgeMs = positiveInteger(options.maxAgeMs ?? DEFAULT_MAX_AGE_MS, 'maxAgeMs')
    this.maxSessionBytes = positiveInteger(
      options.maxSessionBytes ?? DEFAULT_MAX_SESSION_BYTES,
      'maxSessionBytes',
    )
    this.now = options.now ?? (() => new Date())
  }

  open(projectId: string): RawLogSession {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(projectId)) {
      throw new Error('Invalid project ID for raw log storage')
    }
    const logsDirectory = join(this.dataDirectory, 'logs')
    if (existsSync(logsDirectory) && lstatSync(logsDirectory).isSymbolicLink()) {
      throw new Error('Raw log root must not be a symlink')
    }
    const projectDirectory = join(logsDirectory, projectId)
    if (existsSync(projectDirectory) && lstatSync(projectDirectory).isSymbolicLink()) {
      throw new Error('Raw log project directory must not be a symlink')
    }
    mkdirSync(projectDirectory, { recursive: true, mode: 0o700 })
    chmodSync(this.dataDirectory, 0o700)
    chmodSync(logsDirectory, 0o700)
    chmodSync(projectDirectory, 0o700)
    return new RawLogSession(projectDirectory, {
      maxSegmentBytes: this.maxSegmentBytes,
      maxSessionBytes: this.maxSessionBytes,
      prune: () => this.prune(projectDirectory),
    })
  }

  private prune(projectDirectory: string): void {
    const cutoff = this.now().getTime() - this.maxAgeMs
    const entries = readdirSync(projectDirectory)
      .filter((name) => name.endsWith('.log'))
      .map((name) => {
        const path = join(projectDirectory, name)
        return { path, ...statSync(path) }
      })

    for (const entry of entries) {
      if (entry.mtimeMs < cutoff) unlinkSync(entry.path)
    }

    const retained = entries
      .filter((entry) => existsSync(entry.path))
      .sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path))
    let total = retained.reduce((sum, entry) => sum + entry.size, 0)
    for (const entry of retained) {
      if (total <= this.maxProjectBytes) break
      unlinkSync(entry.path)
      total -= entry.size
    }
  }
}

export class RawLogSession {
  private readonly hash = createHash('sha256')
  private readonly paths: string[] = []
  private segment: Segment | undefined
  private byteSize = 0
  private truncated = false
  private closed = false

  constructor(
    private readonly projectDirectory: string,
    private readonly options: { maxSegmentBytes: number; maxSessionBytes: number; prune: () => void },
  ) {}

  write(bytes: Uint8Array): void {
    if (this.closed) throw new Error('Raw log session is closed')
    const incoming = Buffer.from(bytes)
    const remaining = this.options.maxSessionBytes - this.byteSize
    if (remaining <= 0) {
      this.truncated = true
      return
    }
    const buffer = incoming.subarray(0, remaining)
    if (buffer.byteLength < incoming.byteLength) this.truncated = true
    this.hash.update(buffer)
    this.byteSize += buffer.byteLength
    let offset = 0
    try {
      while (offset < buffer.byteLength) {
        const segment = this.currentSegment()
        const writable = Math.min(
          buffer.byteLength - offset,
          this.options.maxSegmentBytes - segment.byteSize,
        )
        writeSync(segment.descriptor, buffer, offset, writable)
        segment.byteSize += writable
        offset += writable
        if (segment.byteSize === this.options.maxSegmentBytes) this.finishSegment()
      }
    } catch (error) {
      try { this.finishSegment() } catch { /* preserve the original write failure */ }
      throw error
    }
  }

  close(): RawLogResult {
    if (this.closed) throw new Error('Raw log session is closed')
    this.closed = true
    if (this.segment) this.finishSegment()
    try { this.options.prune() } catch { /* retained metadata is recomputed below */ }
    const paths = this.paths.filter(existsSync)
    const retained = paths.map((path) => readFileSync(path))
    const byteSize = retained.reduce((total, bytes) => total + bytes.byteLength, 0)
    const digest = createHash('sha256').update(Buffer.concat(retained)).digest('hex')
    this.hash.digest()
    const artifact: RawLogArtifactMetadata = {
      kind: 'command-log',
      digestAlgorithm: 'sha256',
      digest,
      byteSize: this.byteSize,
      retainedByteSize: byteSize,
      paths,
      segmentCount: paths.length,
      truncated: this.truncated || byteSize < this.byteSize,
    }
    return { digest, byteSize, paths, artifact, truncated: artifact.truncated }
  }

  private currentSegment(): Segment {
    if (this.segment) return this.segment
    const sequence = this.paths.length + 1
    const path = join(
      this.projectDirectory,
      `${Date.now()}-${randomUUID()}-${String(sequence).padStart(4, '0')}.log`,
    )
    const descriptor = openSync(path, 'wx', 0o600)
    fchmodSync(descriptor, 0o600)
    this.paths.push(path)
    this.segment = { descriptor, path, byteSize: 0 }
    return this.segment
  }

  private finishSegment(): void {
    if (!this.segment) return
    const segment = this.segment
    this.segment = undefined
    try {
      fsyncSync(segment.descriptor)
    } finally {
      closeSync(segment.descriptor)
    }
  }
}
