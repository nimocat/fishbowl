import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const repositoryRoot = resolve(import.meta.dirname, '../..')

function read(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), 'utf8')
}

describe('Codex Fishbowl access policy', () => {
  it('requires direct MCP tool calls and forbids a CLI fallback', () => {
    const agentRules = read('AGENTS.md')
    const bootstrapPrompt = read('docs/agent-bootstrap-prompt.md')

    for (const document of [agentRules, bootstrapPrompt]) {
      expect(document).toContain('direct Fishbowl MCP tool calls')
      expect(document).toContain('Never fall back to the Fishbowl CLI')
    }

    expect(bootstrapPrompt).toContain('resolve_project')
    expect(bootstrapPrompt).toContain('get_preflight_guidance')
    expect(bootstrapPrompt).toContain('query_knowledge')
    expect(bootstrapPrompt).toContain('checkpoint_work')
    expect(bootstrapPrompt).toContain('Do not search for, locate, or invoke a Fishbowl CLI executable')
    expect(bootstrapPrompt).toContain('Treat MCP tool discovery as the only agent-side Fishbowl discovery path')
    expect(agentRules).toContain('Treat MCP tool discovery as the only Fishbowl discovery path')
    expect(bootstrapPrompt).not.toMatch(/fishbowl (?:query|checkpoint|preflight|project|run)\b/)
    expect(bootstrapPrompt).not.toContain('fishbowl update')
  })

  it('makes the user-level Codex MCP server required', () => {
    const clientConfiguration = read('docs/mcp-client-configuration.md')
    const codexSection = clientConfiguration.match(/## Codex Style([\s\S]*?)## OpenCode Style/)?.[1]

    expect(codexSection).toBeDefined()
    expect(codexSection).toContain('required = true')
    expect(codexSection).toContain('Never fall back to the Fishbowl CLI')
  })

  it('defines proportional light, standard, and full MCP workflows', () => {
    const bootstrapPrompt = read('docs/agent-bootstrap-prompt.md')
    expect(bootstrapPrompt).toContain('LIGHT')
    expect(bootstrapPrompt).toContain('STANDARD')
    expect(bootstrapPrompt).toContain('FULL')
    expect(bootstrapPrompt).not.toContain('disk observation')
    expect(bootstrapPrompt).toContain('Default `query_knowledge` to at most 5 results')
    expect(bootstrapPrompt).toContain('Use `checkpoint_work` only for a real context compaction, interruption, cross-day pause, or handoff')
    expect(bootstrapPrompt).toContain('call `finalize_work` once')
    expect(bootstrapPrompt).toContain('Never infer human Verification')
    expect(bootstrapPrompt).toContain('Record each investigation-changing failed Attempt immediately')
    expect(bootstrapPrompt).toContain('one engineering problem per Case')
    expect(bootstrapPrompt).toContain('stable `sourceKey`')
    expect(bootstrapPrompt).toContain('checkpointOperationId')
    expect(bootstrapPrompt).toContain('supersede_solution')
    expect(bootstrapPrompt).toContain('explicitly confirms the real target behavior')
  })

  it('documents a reproducible Windows update and MCP reconnect flow', () => {
    const readme = read('README.zh-CN.md')
    const englishReadme = read('README.md')
    const clientConfiguration = read('docs/mcp-client-configuration.md')

    expect(readme).toContain('### Windows 更新（PowerShell）')
    expect(readme).toContain('git pull --ff-only origin main')
    expect(readme).toContain('npm ci')
    expect(readme).toContain('Rust stable')
    expect(readme).toContain('fishbowl daemon install')
    expect(readme).toContain('重启 MCP 客户端')
    expect(clientConfiguration).toContain('## Windows Paths')
    expect(clientConfiguration).toContain('(Get-Command node).Source')
    expect(clientConfiguration).toContain('Resolve-Path .\\dist\\cli\\main.js')
    expect(englishReadme).toContain('### Updating on Windows (PowerShell)')
    expect(englishReadme).toContain('git pull --ff-only origin main')
    expect(englishReadme).toContain('Rust stable')

    const windowsJson = clientConfiguration.match(/JSON requires doubled backslashes:\n\n```json\n([\s\S]*?)```/)?.[1]
    expect(windowsJson).toBeDefined()
    expect(() => JSON.parse(windowsJson as string)).not.toThrow()
  })
})
