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
    expect(bootstrapPrompt).not.toMatch(/fishbowl (?:query|checkpoint|preflight|project|run)\b/)
  })

  it('makes the user-level Codex MCP server required', () => {
    const clientConfiguration = read('docs/mcp-client-configuration.md')
    const codexSection = clientConfiguration.match(/## Codex Style([\s\S]*?)## OpenCode Style/)?.[1]

    expect(codexSection).toBeDefined()
    expect(codexSection).toContain('required = true')
    expect(codexSection).toContain('Never fall back to the Fishbowl CLI')
  })
})
