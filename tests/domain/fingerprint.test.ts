import { describe, expect, it } from 'vitest'

import { normalizeFingerprint } from '../../src/domain/fingerprint.js'

describe('fingerprint normalization', () => {
  it('removes unstable values while preserving stable error codes and test identifiers', () => {
    const normalized = normalizeFingerprint(
      `2026-07-13T20:15:30.123Z /Users/eric/work/app/src/compiler.ts:418:27
error TS2307: Cannot find module 'Widget'
run 550e8400-e29b-41d4-a716-446655440000
FAIL tests/domain/compiler.test.ts > compiler resolution > reports TS2307`,
      { projectRoots: ['/Users/eric/work/app'] },
    )

    expect(normalized).toBe(
      `<timestamp> <project>/src/compiler.ts:<line>:<column>
error TS2307: Cannot find module 'Widget'
run <uuid>
FAIL tests/domain/compiler.test.ts > compiler resolution > reports TS2307`,
    )
    expect(normalized).not.toContain('/Users/eric/work/app')
    expect(normalized).not.toContain('2026-07-13')
    expect(normalized).not.toContain('550e8400')
    expect(normalized).not.toContain(':418:27')
  })

  it('normalizes Windows project paths and unstable diagnostic line labels', () => {
    expect(
      normalizeFingerprint(
        'C:\\repo\\app\\src\\main.ts(72,11): error EACCES test auth rejects expired token line 92',
        { projectRoots: ['C:\\repo\\app'] },
      ),
    ).toBe(
      '<project>/src/main.ts(<line>,<column>): error EACCES test auth rejects expired token line <line>',
    )
  })
})
