import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const webRoot = resolve('src/web')

describe('Trace Bench static application', () => {
  it('provides semantic landmarks, labelled controls, live status, and read-only detail regions', () => {
    const html = readFileSync(resolve(webRoot, 'index.html'), 'utf8')

    expect(html).toMatch(/<html lang="en">/)
    expect(html).toMatch(/class="skip-link" href="#main"/)
    expect(html).toMatch(/<main id="main"/)
    expect(html).toMatch(/<label[^>]+for="project-select"/)
    expect(html).toMatch(/<label[^>]+for="search-input"/)
    expect(html).toMatch(/<fieldset[^>]+aria-labelledby="type-filter-label"/)
    expect(html).toMatch(/<fieldset[^>]+aria-labelledby="status-filter-label"/)
    expect(html).toMatch(/id="live-status"[^>]+aria-live="polite"/)
    expect(html).toMatch(/<svg[^>]+id="causal-graph"[^>]+aria-labelledby="graph-title graph-description"/)
    expect(html).toMatch(/<ol id="semantic-trace"/)
    expect(html).toMatch(/<ol id="attempt-timeline"/)
    expect(html).toMatch(/<section[^>]+id="evidence-inspector"/)
    expect(html).toMatch(/<ol id="activity-list"/)
    expect(html).toMatch(/<button[^>]+id="reconnect-button"/)
    expect(html).not.toMatch(/create|edit|delete|record|close case/i)
  })

  it('renders native button nodes, project-scoped reads, live refresh, and explicit UI states', () => {
    const script = readFileSync(resolve(webRoot, 'app.js'), 'utf8')

    expect(script).toContain("document.createElement('button')")
    expect(script).toContain("params.set('project_id', state.projectId)")
    expect(script).toContain("params.set('history_limit', '50')")
    expect(script).toContain("new EventSource")
    expect(script).toContain("snapshot_required")
    expect(script).toMatch(/eventSource\.close\(\)[\s\S]*projectId = event\.target\.value/)
    expect(script).toContain('AbortController')
    expect(script).toContain('if (projectId !== state.projectId) return')
    expect(script).toMatch(/caseRequestController\?\.abort\(\)/)
    expect(script).toMatch(/selectionToken !== state\.selectionToken/)
    expect(script).toContain("edge.relation === 'PRECEDED_BY'")
    expect(script).toContain('caseDetail.commandRuns')
    expect(script).toContain("elements['reconnect-button']")
    expect(script).toContain("state.view = 'empty'")
    expect(script).toContain("state.view = 'error'")
    expect(script).toContain("caseDetail.status === 'regressed'")
    expect(script).not.toMatch(/method:\s*['"](?:POST|PUT|PATCH|DELETE)/)
  })

  it('includes visible focus, reduced-motion, and mobile list-first layout hooks', () => {
    const css = readFileSync(resolve(webRoot, 'styles.css'), 'utf8')

    expect(css).toMatch(/:focus-visible/)
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/)
    expect(css).toMatch(/@media\s*\(max-width:\s*720px\)/)
    expect(css).toMatch(/\.semantic-panel\s*\{[^}]*order:\s*1/s)
    expect(css).toMatch(/\.graph-panel\s*\{[^}]*order:\s*2/s)
  })

  it('copies the static allowlist into a built web directory', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'fishbowl-web-build-'))
    const source = join(sandbox, 'source')
    const destination = join(sandbox, 'dist', 'web')
    mkdirSync(source)
    for (const file of ['index.html', 'styles.css', 'app.js']) {
      writeFileSync(join(source, file), file)
    }

    try {
      execFileSync(process.execPath, ['scripts/copy-static-assets.mjs', source, destination])
      expect(readFileSync(join(destination, 'index.html'), 'utf8')).toBe('index.html')
      expect(readFileSync(join(destination, 'styles.css'), 'utf8')).toBe('styles.css')
      expect(readFileSync(join(destination, 'app.js'), 'utf8')).toBe('app.js')
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})
