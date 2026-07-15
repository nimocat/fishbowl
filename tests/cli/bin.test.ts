import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import * as api from '../../src/index.js'
import { isDirectExecution } from '../../src/cli/direct-execution.js'

const root = fileURLToPath(new URL('../../', import.meta.url))

describe('ekg executable wiring', () => {
  it('publishes the built CLI as the ekg bin with a Node shebang', () => {
    const packageJson = JSON.parse(readFileSync(`${root}/package.json`, 'utf8')) as {
      bin?: Record<string, string>
    }
    const source = readFileSync(`${root}/src/cli/main.ts`, 'utf8')

    expect(packageJson.bin).toEqual({ ekg: './dist/cli/main.js' })
    expect(source.startsWith('#!/usr/bin/env node\n')).toBe(true)
  })

  it('exports the CLI and raw-log APIs from the package entry point', () => {
    expect(api).toMatchObject({
      defaultDataDirectory: expect.any(Function),
      parseArguments: expect.any(Function),
      runCli: expect.any(Function),
      runCommand: expect.any(Function),
      RawLogStore: expect.any(Function),
    })
  })

  it('recognizes npm-style symbolic-link execution as direct', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'ekg-bin-link-'))
    try {
      const target = join(sandbox, 'real-cli.js')
      const link = join(sandbox, 'ekg')
      writeFileSync(target, '#!/usr/bin/env node\n')
      symlinkSync(target, link)
      expect(isDirectExecution(pathToFileURL(target).href, link)).toBe(true)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})
