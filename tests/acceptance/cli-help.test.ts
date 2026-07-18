import { describe, expect, it } from 'vitest'

import { runCli } from '../../src/cli/main.js'

async function invoke(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  const code = await runCli(argv, {
    stdout: { write: value => ((stdout += value.toString()), true) },
    stderr: { write: value => ((stderr += value.toString()), true) },
  })
  return { code, stdout, stderr }
}

describe('human CLI guidance acceptance', () => {
  it('orients a bare invocation without starting the daemon', async () => {
    const result = await invoke([])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('Usage: fishbowl <command> [options]')
    expect(result.stdout).toMatch(/Agents must use.*MCP/i)
  })

  it('resolves help after command options and returns actionable JSON errors', async () => {
    const help = await invoke(['query', '--project', 'example', '--help'])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain('Usage: fishbowl query')

    const invalid = await invoke(['daemon', 'doctr'])
    expect(invalid.code).toBe(1)
    expect(JSON.parse(invalid.stderr)).toMatchObject({
      usage: 'Usage: fishbowl daemon <command> [options]',
      hint: expect.stringContaining('Did you mean `doctor`?'),
      help: 'fishbowl help daemon',
    })
  })
})
