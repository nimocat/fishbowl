import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { RawLogStore } from '../../src/logs/raw-log-store.js'

function tempDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'fishbowl-raw-logs-'))
}

describe('RawLogStore', () => {
  it('stores exact bytes in private project-isolated segments with a SHA-256 digest', () => {
    const dataDirectory = tempDirectory()
    const store = new RawLogStore(dataDirectory, { maxSegmentBytes: 4 })
    const session = store.open('project-a')

    session.write(Buffer.from([0, 1, 2, 3, 4, 255]))
    const result = session.close()

    expect(result.digest).toBe(
      createHash('sha256').update(Buffer.from([0, 1, 2, 3, 4, 255])).digest('hex'),
    )
    expect(result.byteSize).toBe(6)
    expect(result.paths).toHaveLength(2)
    expect(Buffer.concat(result.paths.map((path) => readFileSync(path)))).toEqual(
      Buffer.from([0, 1, 2, 3, 4, 255]),
    )
    expect(result.paths.every((path) => path.startsWith(join(dataDirectory, 'logs', 'project-a'))))
      .toBe(true)
    expect(result.paths.every((path) => (statSync(path).mode & 0o777) === 0o600)).toBe(true)
    expect(result.artifact).toEqual({
      kind: 'command-log',
      digestAlgorithm: 'sha256',
      digest: result.digest,
      byteSize: 6,
      retainedByteSize: 6,
      paths: result.paths,
      segmentCount: 2,
      truncated: false,
    })
    expect(JSON.stringify(result)).not.toContain(process.env.PATH)
  })

  it('prunes expired logs and enforces a total cap within each project only', () => {
    const dataDirectory = tempDirectory()
    let now = new Date('2026-07-13T12:00:00.000Z')
    const store = new RawLogStore(dataDirectory, {
      maxSegmentBytes: 4,
      maxProjectBytes: 6,
      maxAgeMs: 1_000,
      now: () => now,
    })

    const expired = store.open('project-a')
    expired.write(Buffer.from('old!'))
    const expiredResult = expired.close()
    const oldTime = new Date(now.getTime() - 2_000)
    utimesSync(expiredResult.paths[0] as string, oldTime, oldTime)

    const otherProject = store.open('project-b')
    otherProject.write(Buffer.from('keep'))
    const otherResult = otherProject.close()

    now = new Date(now.getTime() + 2_000)
    const current = store.open('project-a')
    current.write(Buffer.from('abcdefgh'))
    const currentResult = current.close()

    expect(currentResult.paths.map((path) => readFileSync(path).toString())).toEqual(['efgh'])
    expect(() => statSync(expiredResult.paths[0] as string)).toThrow()
    expect(readFileSync(otherResult.paths[0] as string, 'utf8')).toBe('keep')
  })

  it('rejects project IDs that could escape the log root', () => {
    const store = new RawLogStore(tempDirectory())

    expect(() => store.open('../client-project')).toThrow('project ID')
  })

  it('rejects symlinked log roots and caps retained bytes during writes', () => {
    const dataDirectory = tempDirectory()
    const outside = tempDirectory()
    symlinkSync(outside, join(dataDirectory, 'logs'))
    expect(() => new RawLogStore(dataDirectory).open('project-a')).toThrow(/symlink/i)

    const safeData = tempDirectory()
    mkdirSync(join(safeData, 'logs'))
    const session = new RawLogStore(safeData, { maxSessionBytes: 5 }).open('project-a')
    session.write(Buffer.from('123456789'))
    const result = session.close()
    expect(result.byteSize).toBe(5)
    expect(result.truncated).toBe(true)
    expect(Buffer.concat(result.paths.map((path) => readFileSync(path))).toString()).toBe('12345')
  })
})
