import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_PAYLOAD_LIMIT_BYTES,
  isPathWithinBoundary,
  payloadByteLength,
  validatePayloadSize,
} from '../../src/domain/policies.js'
import { boundedRedactedExcerpt, redactArgv, redactSecrets } from '../../src/security/redaction.js'

describe('secret redaction', () => {
  it('redacts token, password, authorization, and provider credential formats', () => {
    const input = [
      'token=plain-token',
      'password: hunter2',
      'Authorization: Bearer abc.def.ghi',
      'https://user:secret@example.com/repo',
      'github_pat_11AAABBB_ccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      'AKIAIOSFODNN7EXAMPLE',
    ].join('\n')

    const redacted = redactSecrets(input)

    expect(redacted).not.toMatch(/plain-token|hunter2|abc\.def\.ghi|user:secret|github_pat_|AKIAIOS/)
    expect(redacted.match(/\[REDACTED\]/g)?.length).toBe(6)
  })

  it('redacts before producing a valid UTF-8 byte-bounded excerpt', () => {
    const excerpt = boundedRedactedExcerpt('password=秘密\n' + 'é'.repeat(100), 31)

    expect(Buffer.byteLength(excerpt, 'utf8')).toBeLessThanOrEqual(31)
    expect(excerpt).toContain('[REDACTED]')
    expect(excerpt).not.toContain('秘密')
    expect(excerpt).not.toContain('�')
  })

  it('redacts command flags and JSON credential values', () => {
    const redacted = redactSecrets(
      '--token command-secret --password=inline-secret {"password":"json-secret"}',
    )

    expect(redacted).not.toMatch(/command-secret|inline-secret|json-secret/)
    expect(redacted.match(/\[REDACTED\]/g)?.length).toBe(3)
  })

  it('redacts sensitive values supplied as the next argv element', () => {
    expect(redactArgv([
      'tool', '--token', 'token-value', '--api-key', 'api-value', '--password=inline', 'safe',
    ])).toEqual([
      'tool', '--token', '[REDACTED]', '--api-key', '[REDACTED]', '--password=[REDACTED]', 'safe',
    ])
  })
})

describe('path and payload boundaries', () => {
  const sandboxes: string[] = []

  afterEach(() => {
    for (const sandbox of sandboxes.splice(0)) {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it('accepts project/data descendants and rejects traversal, siblings, and prefix collisions', () => {
    expect(isPathWithinBoundary('/work/project/src/a.ts', ['/work/project', '/var/ekg/data'])).toBe(
      true,
    )
    expect(isPathWithinBoundary('/var/ekg/data/logs/a.log', ['/work/project', '/var/ekg/data'])).toBe(
      true,
    )
    expect(isPathWithinBoundary('/work/project/../secret', ['/work/project'])).toBe(false)
    expect(isPathWithinBoundary('/work/project-copy/a.ts', ['/work/project'])).toBe(false)
    expect(isPathWithinBoundary('relative/a.ts', ['/work/project'])).toBe(false)
  })

  it('rejects an existing symlink that escapes an allowed root', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'ekg-path-policy-'))
    sandboxes.push(sandbox)
    const projectRoot = join(sandbox, 'project')
    const outside = join(sandbox, 'outside')
    mkdirSync(projectRoot)
    mkdirSync(outside)
    symlinkSync(outside, join(projectRoot, 'linked'))

    expect(isPathWithinBoundary(join(projectRoot, 'linked'), [projectRoot])).toBe(false)
  })

  it('measures serialized UTF-8 bytes and reports the configured payload limit', () => {
    expect(payloadByteLength({ text: 'é' })).toBe(Buffer.byteLength(JSON.stringify({ text: 'é' })))
    expect(validatePayloadSize({ text: 'x' })).toEqual({
      valid: true,
      byteLength: 12,
      limitBytes: DEFAULT_PAYLOAD_LIMIT_BYTES,
    })
    expect(validatePayloadSize({ text: 'éé' }, 13)).toEqual({
      valid: false,
      byteLength: 15,
      limitBytes: 13,
    })
  })
})
