import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import {
  KnowledgeService,
  closeDatabase,
  openDatabase,
  startTraceBenchServer,
  type RunningTraceBenchServer,
} from '../../src/index.js'

const require = createRequire(import.meta.url)

test('renders an accessible isolated trace and applies live SSE updates', async ({ page }) => {
  const sandbox = mkdtempSync(join(tmpdir(), 'ekg-browser-'))
  const rootA = join(sandbox, 'alpha')
  const rootB = join(sandbox, 'beta')
  mkdirSync(rootA)
  mkdirSync(rootB)
  const database = openDatabase(join(sandbox, 'knowledge.db'))
  const service = new KnowledgeService(database)
  let server: RunningTraceBenchServer | undefined

  try {
    const alpha = service.registerProject({ name: 'Alpha', root: rootA })
    service.registerProject({ name: 'Beta', root: rootB })
    const problem = service.recordProblem({
      project: { projectId: alpha.id },
      caseTitle: 'Compiler trace',
      data: { summary: 'Module TraceKit cannot be resolved', domain: 'build' },
    })
    server = await startTraceBenchServer({
      service,
      port: 0,
      sse: { pollIntervalMs: 10, heartbeatIntervalMs: 50 },
    })

    await page.addInitScript({ path: require.resolve('axe-core/axe.min.js') })
    await page.goto(`http://127.0.0.1:${server.address.port}`)
    await expect(page.getByRole('heading', { name: 'Trace Bench' })).toBeVisible()
    await expect(page.locator('#project-select option')).toHaveCount(2)
    await expect(page.locator('#semantic-trace')).toContainText(
      'Module TraceKit cannot be resolved',
    )
    await expect(page.locator('#live-status')).toHaveText('Live')

    await page.keyboard.press('Tab')
    await expect(page.locator('.skip-link')).toBeFocused()

    const violations = await page.evaluate(async () => {
      const axe = (globalThis as typeof globalThis & {
        axe: { run(): Promise<{ violations: Array<{ impact: string | null; id: string }> }> }
      }).axe
      const result = await axe.run()
      return result.violations.filter((violation) =>
        violation.impact === 'critical' || violation.impact === 'serious')
    })
    expect(violations).toEqual([])

    service.recordAttempt({
      project: { projectId: alpha.id },
      caseId: problem.caseId,
      problemId: problem.nodeId,
      data: {
        hypothesis: 'Live dependency inspection',
        change: 'Inspect package products',
        outcome: 'failed',
        failureExplanation: 'Product remains absent',
      },
    })

    await expect(page.locator('#semantic-trace')).toContainText(
      'Live dependency inspection',
    )
    await page.locator('#project-select').selectOption({ label: 'Beta' })
    await expect(page.locator('#semantic-trace')).not.toContainText(
      'Module TraceKit cannot be resolved',
    )
    await expect(page.locator('#view-state')).toContainText('no Cases', {
      ignoreCase: true,
    })
  } finally {
    await page.close()
    await server?.close()
    closeDatabase(database)
    rmSync(sandbox, { recursive: true, force: true })
  }
})

test('keeps the latest same-project Case selection when an older response arrives late', async ({ page }) => {
  const sandbox = mkdtempSync(join(tmpdir(), 'ekg-browser-selection-'))
  const root = join(sandbox, 'project')
  mkdirSync(root)
  const database = openDatabase(join(sandbox, 'knowledge.db'))
  const service = new KnowledgeService(database)
  let server: RunningTraceBenchServer | undefined

  try {
    const project = service.registerProject({ name: 'Project', root })
    const older = service.recordProblem({
      project: { projectId: project.id }, caseTitle: 'Older response',
      data: { summary: 'Stale Case detail' },
    })
    service.recordProblem({
      project: { projectId: project.id }, caseTitle: 'Latest selection',
      data: { summary: 'Current Case detail' },
    })
    server = await startTraceBenchServer({ service, port: 0 })
    await page.goto(`http://127.0.0.1:${server.address.port}`)
    await expect(page.locator('#case-results')).toContainText('Latest selection')

    await page.route(`**/api/v1/cases/${older.caseId}?**`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 250))
      await route.continue()
    })
    await page.getByRole('button', { name: /Older response/ }).click()
    await page.getByRole('button', { name: /Latest selection/ }).click()

    await expect(page.locator('#semantic-trace')).toContainText('Current Case detail')
    await page.waitForTimeout(350)
    await expect(page.locator('#semantic-trace')).toContainText('Current Case detail')
    await expect(page.locator('#semantic-trace')).not.toContainText('Stale Case detail')
  } finally {
    await page.close()
    await server?.close()
    closeDatabase(database)
    rmSync(sandbox, { recursive: true, force: true })
  }
})
