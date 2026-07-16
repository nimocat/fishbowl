import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

const root = process.cwd()

describe('Rust core architecture boundary', () => {
  it('has no TypeScript SQLite runtime dependency', () => {
    const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(packageJson.dependencies).not.toHaveProperty('better-sqlite3')
  })

  it('keeps MCP, web, CLI, and daemon adapters free of core implementation imports', () => {
    const adapterRoots = ['src/mcp', 'src/web', 'src/cli', 'src/daemon']
    const forbidden = [
      'storage/', 'knowledge-service', 'query-planner', 'application/relevance',
      'domain/policies', 'security/redaction', 'better-sqlite3',
    ]
    const violations: string[] = []
    for (const directory of adapterRoots) {
      for (const file of files(join(root, directory))) {
        if (!/\.(?:ts|js)$/.test(file)) continue
        const source = readFileSync(file, 'utf8')
        for (const token of forbidden) {
          if (source.includes(token)) violations.push(`${relative(root, file)} -> ${token}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('does not retain a parallel TypeScript policy or persistence core', () => {
    const removed = [
      'src/application/knowledge-service.ts',
      'src/application/query-planner.ts',
      'src/application/relevance.ts',
      'src/storage/database.ts',
      'src/storage/schema.ts',
      'src/domain/policies.ts',
      'src/security/redaction.ts',
    ]
    expect(removed.filter((file) => statExists(join(root, file)))).toEqual([])
  })
})

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

function statExists(path: string): boolean {
  try { return statSync(path).isFile() } catch { return false }
}
