import { describe, expect, it } from 'vitest'

import {
  updateFishbowl,
  type UpdateCommandInvocation,
  type UpdateCommandResult,
  type UpdateDeploymentStore,
} from '../../src/cli/update.js'

const OFFICIAL = 'https://github.com/nimocat/fishbowl.git'
type ResponseEntry = [string, string[], UpdateCommandResult]

class FakeRunner {
  readonly calls: UpdateCommandInvocation[] = []

  constructor(readonly responses: Map<string, UpdateCommandResult[]>) {}

  run = (invocation: UpdateCommandInvocation): UpdateCommandResult => {
    this.calls.push(invocation)
    const queued = this.responses.get(key(invocation.file, invocation.args))
    if (queued && queued.length > 1) return queued.shift() as UpdateCommandResult
    return queued?.[0] ?? { status: 0, stdout: '' }
  }
}

class FakeDeployment implements UpdateDeploymentStore {
  prepared = false
  restored = 0
  committed = 0

  constructor(public revision: string | undefined) {}

  readRevision = () => this.revision
  prepareBackup = () => { this.prepared = true }
  restoreBackup = () => {
    if (!this.prepared) return false
    this.prepared = false
    this.restored += 1
    return true
  }
  commit = (revision: string) => {
    this.revision = revision
    this.prepared = false
    this.committed += 1
  }
}

function key(file: string, args: string[]): string {
  return `${file}\0${args.join('\0')}`
}

function happyRunner(overrides: ResponseEntry[] = []): FakeRunner {
  const responses = new Map<string, UpdateCommandResult[]>([
    [key('git', ['rev-parse', '--show-toplevel']), [{ status: 0, stdout: 'C:\\src\\fishbowl\n' }]],
    [key('git', ['status', '--porcelain=v1']), [{ status: 0, stdout: '' }]],
    [key('git', ['remote', 'get-url', 'origin']), [{ status: 0, stdout: `${OFFICIAL}\n` }]],
    [key('git', ['branch', '--show-current']), [{ status: 0, stdout: 'main\n' }]],
    [key('git', ['rev-parse', 'HEAD']), [{ status: 0, stdout: 'old-revision\n' }]],
    [key('git', ['rev-parse', 'origin/main']), [{ status: 0, stdout: 'new-revision\n' }]],
    [key('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main']), [{ status: 0, stdout: '' }]],
  ])
  for (const [file, args, result] of overrides) responses.set(key(file, args), [result])
  return new FakeRunner(responses)
}

describe('Fishbowl self update', () => {
  it('fast-forwards, then rebuilds and refreshes the Windows daemon in exact safe order', () => {
    const runner = happyRunner()
    const deployment = new FakeDeployment('old-revision')

    const result = updateFishbowl({
      sourceRoot: 'C:\\src\\fishbowl',
      platform: 'win32',
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      runner: runner.run,
      deployment,
    })

    expect(result).toEqual({
      updated: true,
      deploymentRefreshed: true,
      previousRevision: 'old-revision',
      currentRevision: 'new-revision',
      branch: 'main',
    })
    expect(deployment.revision).toBe('new-revision')
    expect(runner.calls.map(({ file, args }) => [file, args])).toEqual([
      ['git', ['rev-parse', '--show-toplevel']],
      ['git', ['status', '--porcelain=v1']],
      ['git', ['remote', 'get-url', 'origin']],
      ['git', ['branch', '--show-current']],
      ['git', ['rev-parse', 'HEAD']],
      ['git', ['fetch', 'origin', 'refs/heads/main:refs/remotes/origin/main']],
      ['git', ['rev-parse', 'origin/main']],
      ['git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main']],
      ['git', ['merge', '--ff-only', 'origin/main']],
      ['cmd.exe', ['/d', '/s', '/c', 'npm.cmd', 'ci']],
      ['C:\\Program Files\\nodejs\\node.exe', ['C:\\src\\fishbowl\\dist\\cli\\main.js', 'daemon', 'stop']],
      ['C:\\Program Files\\nodejs\\node.exe', ['C:\\src\\fishbowl\\dist\\cli\\main.js', 'daemon', 'uninstall']],
      ['cmd.exe', ['/d', '/s', '/c', 'npm.cmd', 'run', 'build']],
      ['cmd.exe', ['/d', '/s', '/c', 'npm.cmd', 'link']],
      ['C:\\Program Files\\nodejs\\node.exe', ['C:\\src\\fishbowl\\dist\\cli\\main.js', 'daemon', 'install']],
      ['C:\\Program Files\\nodejs\\node.exe', ['C:\\src\\fishbowl\\dist\\cli\\main.js', 'project', 'list']],
      ['C:\\Program Files\\nodejs\\node.exe', ['C:\\src\\fishbowl\\dist\\cli\\main.js', 'daemon', 'doctor']],
    ])
  })

  it('returns a true no-op only when source and deployed revisions both match', () => {
    const runner = happyRunner([
      ['git', ['rev-parse', 'origin/main'], { status: 0, stdout: 'old-revision\n' }],
    ])
    const deployment = new FakeDeployment('old-revision')
    const result = updateFishbowl({
      sourceRoot: 'C:\\src\\fishbowl',
      platform: 'win32',
      runner: runner.run,
      deployment,
    })

    expect(result).toMatchObject({ updated: false, deploymentRefreshed: false })
    expect(runner.calls.some(({ args }) => args.includes('build'))).toBe(false)
    expect(runner.calls.some(({ args }) => args.includes('stop'))).toBe(false)
  })

  it('refuses dirty, non-main, untrusted, and non-fast-forward checkouts before worktree or daemon mutation', () => {
    const cases: Array<[ResponseEntry[], RegExp]> = [
      [[['git', ['status', '--porcelain=v1'], { status: 0, stdout: '?? private-file\n' }]], /working tree is not clean/i],
      [[['git', ['remote', 'get-url', 'origin'], { status: 0, stdout: 'https:\/\/example.com\/fork.git\n' }]], /official Fishbowl origin/i],
      [[['git', ['branch', '--show-current'], { status: 0, stdout: 'feature\n' }]], /main branch/i],
      [[['git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], { status: 1, stdout: '' }]], /cannot be fast-forwarded/i],
    ]

    for (const [overrides, expected] of cases) {
      const runner = happyRunner(overrides)
      expect(() => updateFishbowl({
        sourceRoot: 'C:\\src\\fishbowl',
        platform: 'win32',
        runner: runner.run,
        deployment: new FakeDeployment('old-revision'),
      })).toThrow(expected)
      expect(runner.calls.some(({ args }) => args.includes('merge'))).toBe(false)
      expect(runner.calls.some(({ args }) => args.includes('stop'))).toBe(false)
      expect(runner.calls.some(({ args }) => args.includes('build'))).toBe(false)
    }
  })

  it('restores the previous deployment after failure and the next update repairs the same revision', () => {
    const deployment = new FakeDeployment('old-revision')
    const failed = happyRunner([
      ['npm', ['run', 'build'], { status: 1, stdout: '' }],
    ])

    expect(() => updateFishbowl({
      sourceRoot: 'C:\\src\\fishbowl',
      platform: 'darwin',
      runner: failed.run,
      deployment,
      sleep: () => {},
    })).toThrow(/failed during build.*previous CLI and daemon were restored.*rerun fishbowl update/is)
    expect(deployment.restored).toBe(1)
    expect(deployment.revision).toBe('old-revision')

    const retry = happyRunner([
      ['git', ['rev-parse', '--show-toplevel'], { status: 0, stdout: '/src/fishbowl\n' }],
      ['git', ['rev-parse', 'HEAD'], { status: 0, stdout: 'new-revision\n' }],
      ['git', ['rev-parse', 'origin/main'], { status: 0, stdout: 'new-revision\n' }],
    ])
    const repaired = updateFishbowl({
      sourceRoot: '/src/fishbowl',
      platform: 'darwin',
      runner: retry.run,
      deployment,
      sleep: () => {},
    })

    expect(repaired).toMatchObject({ updated: false, deploymentRefreshed: true })
    expect(deployment.revision).toBe('new-revision')
    expect(retry.calls.some(({ args }) => args[0] === 'merge')).toBe(false)
  })

  it('leaves the running daemon untouched when the deployment backup cannot be prepared', () => {
    const runner = happyRunner([
      ['git', ['rev-parse', '--show-toplevel'], { status: 0, stdout: '/src/fishbowl\n' }],
    ])
    const deployment: UpdateDeploymentStore = {
      readRevision: () => 'old-revision',
      prepareBackup: () => { throw new Error('backup unavailable') },
      restoreBackup: () => false,
      commit: () => {},
    }

    expect(() => updateFishbowl({
      sourceRoot: '/src/fishbowl',
      platform: 'darwin',
      nodeExecutable: '/usr/local/bin/node',
      runner: runner.run,
      deployment,
    })).toThrow(/failed during build backup.*manual attention/is)

    expect(runner.calls.some(({ args }) => args.includes('stop'))).toBe(false)
    expect(runner.calls.some(({ args }) => args.includes('uninstall'))).toBe(false)
    expect(runner.calls.some(({ args }) => args.includes('install'))).toBe(false)
  })

  it('recovers the prior daemon when registration removal fails after shutdown starts', () => {
    const runner = happyRunner([
      ['git', ['rev-parse', '--show-toplevel'], { status: 0, stdout: '/src/fishbowl\n' }],
      ['/usr/local/bin/node', ['/src/fishbowl/dist/cli/main.js', 'daemon', 'uninstall'], { status: 1, stdout: '' }],
    ])
    const deployment = new FakeDeployment('old-revision')

    expect(() => updateFishbowl({
      sourceRoot: '/src/fishbowl',
      platform: 'darwin',
      nodeExecutable: '/usr/local/bin/node',
      runner: runner.run,
      deployment,
      sleep: () => {},
    })).toThrow(/failed during daemon registration removal.*previous CLI and daemon were restored/is)

    expect(deployment.restored).toBe(1)
    expect(runner.calls.filter(({ args }) => args.includes('install'))).toHaveLength(1)
    expect(runner.calls.some(({ args }) => args.includes('doctor'))).toBe(true)
  })

  it('waits for the registered macOS daemon without using the auto-spawn project path', () => {
    const runner = happyRunner([
      ['git', ['rev-parse', '--show-toplevel'], { status: 0, stdout: '/src/fishbowl\n' }],
    ])
    runner.responses.set(
      key('/usr/local/bin/node', ['/src/fishbowl/dist/cli/main.js', 'daemon', 'doctor']),
      [{ status: 1, stdout: '' }, { status: 0, stdout: '' }],
    )
    const sleeps: number[] = []

    updateFishbowl({
      sourceRoot: '/src/fishbowl',
      platform: 'darwin',
      nodeExecutable: '/usr/local/bin/node',
      runner: runner.run,
      deployment: new FakeDeployment('old-revision'),
      sleep: (milliseconds) => sleeps.push(milliseconds),
    })

    expect(sleeps).toEqual([25])
    expect(runner.calls.some(({ args }) => args.includes('project'))).toBe(false)
  })
})
