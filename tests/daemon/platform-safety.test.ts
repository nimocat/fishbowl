import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

describe('daemon platform installation safety', () => {
  it('never signals a PID from a stale daemon descriptor during Windows registration', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../src/daemon/platform.ts', import.meta.url)),
      'utf8',
    )

    expect(source).not.toContain('process.kill')
    expect(source).not.toContain('readDaemonDescriptor')
  })
})
