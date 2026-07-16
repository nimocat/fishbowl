import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  decodeRustSuccess,
  encodeRustReadRequest,
} from '../../src/rust/contract-adapter.js'

function fixture(name: string): { request: unknown; response: unknown } {
  return JSON.parse(readFileSync(join(process.cwd(), 'fixtures/contracts', name), 'utf8'))
}

describe('Rust contract adapter', () => {
  it.each(['query_knowledge.json', 'preflight.json', 'get_case.json'])(
    'replays %s without interpreting the result',
    (name) => {
      const value = fixture(name)
      expect(encodeRustReadRequest(value.request)).toEqual(value.request)
      expect(decodeRustSuccess(value.response)).toEqual(value.response)
    },
  )

  it('rejects unknown fields and malformed success envelopes', () => {
    const value = fixture('query_knowledge.json')
    expect(() => encodeRustReadRequest({
      ...(value.request as object),
      unexpected: true,
    })).toThrow('Invalid Rust daemon request contract')
    expect(() => decodeRustSuccess({ ok: false, result: {} }))
      .toThrow('Invalid Rust daemon success contract')
  })

  it('remains a serialization-only boundary', () => {
    const source = readFileSync(join(process.cwd(), 'src/rust/contract-adapter.ts'), 'utf8')
    expect(source).not.toMatch(/storage|sqlite|better-sqlite3|policy|KnowledgeService/)
  })
})
