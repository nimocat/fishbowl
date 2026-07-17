import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { runCli } from '../../src/cli/main.js'

describe('CLI command dispatch', () => {
  const sandboxes: string[] = []

  function sandbox(): { data: string; project: string } {
    const root = mkdtempSync(join(tmpdir(), 'fishbowl-cli-'))
    sandboxes.push(root)
    const project = join(root, 'project')
    mkdirSync(project)
    return { data: join(root, 'user-data'), project }
  }

  async function invoke(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    let stdout = ''
    let stderr = ''
    const code = await runCli(argv, {
      stdout: { write: (value: string | Uint8Array) => ((stdout += value.toString()), true) },
      stderr: { write: (value: string | Uint8Array) => ((stderr += value.toString()), true) },
      daemonDetached: false,
    })
    return { code, stdout, stderr }
  }

  afterEach(async () => {
    for (const path of sandboxes.splice(0)) {
      const pidFile = join(path, 'user-data', 'daemon.pid')
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, 'utf8').trim())
        try { process.kill(pid, 'SIGTERM') } catch { /* already stopped */ }
        for (let attempt = 0; attempt < 100; attempt += 1) {
          try { process.kill(pid, 0) } catch { break }
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        try {
          process.kill(pid, 0)
          throw new Error(`test-owned daemon ${pid} survived cleanup`)
        } catch (error) {
          if (error instanceof Error && error.message.includes('survived cleanup')) throw error
        }
      }
      rmSync(path, { recursive: true, force: true })
    }
  })

  it('registers, lists, resolves, updates, and queries a project as JSON', async () => {
    const { data, project } = sandbox()
    const registered = await invoke([
      '--data-dir', data, 'project', 'register', '--root', project, '--name', 'CLI Project',
    ])
    const projectId = (JSON.parse(registered.stdout) as { id: string }).id

    expect(registered.code).toBe(0)
    expect((JSON.parse((await invoke(['--data-dir', data, 'project', 'list'])).stdout) as unknown[]))
      .toHaveLength(1)
    expect(JSON.parse((await invoke([
      '--data-dir', data, 'project', 'resolve', '--root', project,
    ])).stdout)).toMatchObject({ id: projectId })
    expect(JSON.parse((await invoke([
      '--data-dir', data, 'project', 'update', '--project', projectId,
      '--description', 'updated',
    ])).stdout)).toMatchObject({ description: 'updated' })

    const query = await invoke(['--data-dir', data, 'query', '--project', projectId, 'nothing'])
    expect(query.code).toBe(0)
    expect(JSON.parse(query.stdout)).toMatchObject({ items: [] })
  })

  it('previews and applies explicit imports, then exports and imports a graph archive', async () => {
    const { data, project } = sandbox()
    const source = join(project, 'notes.md')
    writeFileSync(source, '# Build failure\nGenerated source was missing.')
    const projectId = (JSON.parse((await invoke([
      '--data-dir', data, 'project', 'register', '--root', project, '--name', 'Source',
    ])).stdout) as { id: string }).id
    const preview = JSON.parse((await invoke([
      '--data-dir', data, 'import', 'preview', '--project', projectId,
      '--sources-json', JSON.stringify([{ kind: 'file', path: source }]),
    ])).stdout) as { previewId: string; proposals: Array<{ id: string }> }

    const applied = await invoke([
      '--data-dir', data, 'import', 'apply', '--project', projectId,
      '--preview', preview.previewId,
      '--proposals-json', JSON.stringify(preview.proposals.map(({ id }) => id)),
      '--operation', 'apply-1',
    ])
    expect(JSON.parse(applied.stdout)).toMatchObject({ created: preview.proposals.length })

    const archivePath = join(project, 'archive.json')
    expect((await invoke([
      '--data-dir', data, 'export', '--project', projectId, '--output', archivePath,
    ])).code).toBe(0)
    expect(JSON.parse(readFileSync(archivePath, 'utf8'))).toMatchObject({
      format: 'fishbowl',
    })

    const target = join(project, 'target')
    mkdirSync(target)
    const targetId = (JSON.parse((await invoke([
      '--data-dir', data, 'project', 'register', '--root', target, '--name', 'Target',
    ])).stdout) as { id: string }).id
    const imported = await invoke([
      '--data-dir', data, 'import', 'graph', '--project', targetId,
      '--file', archivePath, '--operation', 'graph-1',
    ])
    expect(JSON.parse(imported.stdout)).toMatchObject({ targetProjectId: targetId })
  })

  it('checks integrity and gives non-destructive recovery guidance for corruption', async () => {
    const { data } = sandbox()
    const healthy = await invoke(['--data-dir', data, 'integrity'])

    expect(healthy.code).toBe(0)
    expect(JSON.parse(healthy.stdout)).toMatchObject({ ok: true, check: 'quick_check' })

    const databasePath = join(data, 'knowledge.db')
    const corruptBytes = Buffer.from('corrupt database sentinel')
    writeFileSync(databasePath, corruptBytes)
    const corrupt = await invoke(['--data-dir', data, 'integrity'])

    expect(corrupt.code).toBe(1)
    expect(corrupt.stdout).toBe('')
    expect(corrupt.stderr).toMatch(/read-only recovery mode/i)
    expect(corrupt.stderr).toMatch(/back up/i)
    expect(corrupt.stderr).toMatch(/\.recover/i)
    expect(corrupt.stderr).toMatch(/export/i)
    expect(readFileSync(databasePath)).toEqual(corruptBytes)
  })

  it('records a concise checkpoint without requiring JSON', async () => {
    const { data, project } = sandbox()
    const projectId = (JSON.parse((await invoke([
      '--data-dir', data, 'project', 'register', '--root', project, '--name', 'Checkpoint',
    ])).stdout) as { id: string }).id
    const result = await invoke([
      '--data-dir', data, 'checkpoint', '--project', projectId,
      '--task', 'Fix Metal flicker', '--outcome', 'failed', '--summary', 'Gaussian pass regressed latency',
    ])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ recorded: true, createdCase: true })
  })

  it('rejects malformed checkpoint assertions locally with actionable field guidance', async () => {
    const { data } = sandbox()
    const result = await invoke([
      '--data-dir', data, 'checkpoint', '--project', 'project-a',
      '--task', 'Malformed checkpoint', '--outcome', 'inconclusive',
      '--summary', 'The daemon must not receive this payload.',
      '--data-json', JSON.stringify({
        rootCause: 'plain text',
        solution: 'plain text',
      }),
    ])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/rootCause must be an object/i)
    expect(result.stderr).toMatch(/explanation.*confidence/i)
    expect(existsSync(join(data, 'daemon.pid'))).toBe(false)

    const incompleteSolution = await invoke([
      '--data-dir', data, 'checkpoint', '--project', 'project-a',
      '--task', 'Incomplete solution', '--outcome', 'inconclusive',
      '--summary', 'Required arrays are absent.',
      '--data-json', JSON.stringify({
        solution: { summary: 'Validate locally', decisiveDifference: 'No daemon request' },
      }),
    ])
    expect(incompleteSolution.code).toBe(1)
    expect(incompleteSolution.stderr).toMatch(/solution\.applicability must be a non-empty array/i)
    expect(existsSync(join(data, 'daemon.pid'))).toBe(false)
  })
})
