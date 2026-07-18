import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

const OFFICIAL_ORIGIN = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)nimocat\/fishbowl(?:\.git)?\/?$/i

export interface UpdateCommandInvocation {
  file: string
  args: string[]
  cwd: string
  output: 'capture' | 'inherit'
}

export interface UpdateCommandResult {
  status: number
  stdout: string
}

export type UpdateCommandRunner = (invocation: UpdateCommandInvocation) => UpdateCommandResult

export interface FishbowlUpdateResult {
  updated: boolean
  deploymentRefreshed: boolean
  previousRevision: string
  currentRevision: string
  branch: 'main'
}

export interface UpdateDeploymentStore {
  readRevision(): string | undefined
  prepareBackup(): void
  restoreBackup(): boolean
  commit(revision: string): void
}

export function defaultFishbowlSourceRoot(moduleUrl = import.meta.url): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), '..', '..')
}

export function updateFishbowl(options: {
  sourceRoot?: string
  platform?: NodeJS.Platform
  nodeExecutable?: string
  runner?: UpdateCommandRunner
  deployment?: UpdateDeploymentStore
  prepareDaemonShutdown?: () => void
  healthAttempts?: number
  sleep?: (milliseconds: number) => void
} = {}): FishbowlUpdateResult {
  const sourceRoot = options.sourceRoot ?? defaultFishbowlSourceRoot()
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin' && platform !== 'win32') {
    throw new Error('fishbowl update currently supports macOS and Windows')
  }
  const nodeExecutable = options.nodeExecutable ?? process.execPath
  const runner = options.runner ?? systemRunner
  const deployment = options.deployment ?? fileDeploymentStore(sourceRoot)
  const sleep = options.sleep ?? synchronousSleep
  const run = (file: string, args: string[], output: 'capture' | 'inherit' = 'capture') =>
    runner({ file, args, cwd: sourceRoot, output })
  const checked = (file: string, args: string[], stage: string, output: 'capture' | 'inherit' = 'capture') => {
    const result = run(file, args, output)
    if (result.status !== 0) throw new Error(`Command failed during ${stage}`)
    return result.stdout.trim()
  }

  const topLevel = checked('git', ['rev-parse', '--show-toplevel'], 'source checkout validation')
  if (normalizePath(topLevel) !== normalizePath(sourceRoot)) {
    throw new Error('fishbowl update must run from the installed Fishbowl source checkout')
  }
  if (checked('git', ['status', '--porcelain=v1'], 'working tree validation') !== '') {
    throw new Error('Fishbowl working tree is not clean; commit, stash, or remove local changes before updating')
  }
  const origin = checked('git', ['remote', 'get-url', 'origin'], 'origin validation')
  if (!OFFICIAL_ORIGIN.test(origin)) {
    throw new Error('fishbowl update requires the official Fishbowl origin (github.com/nimocat/fishbowl)')
  }
  const branch = checked('git', ['branch', '--show-current'], 'branch validation')
  if (branch !== 'main') throw new Error('fishbowl update requires the main branch')
  const previousRevision = checked('git', ['rev-parse', 'HEAD'], 'revision discovery')

  checked(
    'git',
    ['fetch', 'origin', 'refs/heads/main:refs/remotes/origin/main'],
    'fetch',
    'inherit',
  )
  const currentRevision = checked('git', ['rev-parse', 'origin/main'], 'remote revision discovery')
  const sourceUpdateRequired = previousRevision !== currentRevision
  const deploymentRefreshRequired = deployment.readRevision() !== currentRevision
  if (!sourceUpdateRequired && !deploymentRefreshRequired) {
    return {
      updated: false,
      deploymentRefreshed: false,
      previousRevision,
      currentRevision,
      branch: 'main',
    }
  }
  if (sourceUpdateRequired) {
    const ancestor = run('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'])
    if (ancestor.status !== 0) {
      throw new Error('Local main cannot be fast-forwarded to origin/main; reconcile it manually')
    }
  }

  const cliEntry = platform === 'win32'
    ? win32.join(sourceRoot, 'dist', 'cli', 'main.js')
    : join(sourceRoot, 'dist', 'cli', 'main.js')
  let backupPrepared = false
  let daemonDowntimeStarted = false
  let phase = 'fast-forward'
  try {
    if (sourceUpdateRequired) {
      checked('git', ['merge', '--ff-only', 'origin/main'], phase, 'inherit')
    }
    phase = 'dependency installation'
    checkedNpm(run, platform, ['ci'], phase)
    phase = 'build backup'
    deployment.prepareBackup()
    backupPrepared = true
    phase = 'daemon endpoint preservation'
    options.prepareDaemonShutdown?.()
    phase = 'daemon shutdown'
    daemonDowntimeStarted = true
    checked(nodeExecutable, [cliEntry, 'daemon', 'stop'], phase)
    phase = 'daemon registration removal'
    checked(nodeExecutable, [cliEntry, 'daemon', 'uninstall'], phase)
    phase = 'build'
    checkedNpm(run, platform, ['run', 'build'], phase)
    phase = 'global link refresh'
    checkedNpm(run, platform, ['link'], phase)
    phase = 'daemon installation'
    checked(nodeExecutable, [cliEntry, 'daemon', 'install'], phase)
    startAndVerifyDaemon({
      run,
      platform,
      nodeExecutable,
      cliEntry,
      attempts: options.healthAttempts ?? 100,
      sleep,
    })
    phase = 'deployment marker'
    deployment.commit(currentRevision)
    backupPrepared = false
  } catch {
    let daemonRestored = !daemonDowntimeStarted
    if (backupPrepared) deployment.restoreBackup()
    if (daemonDowntimeStarted) {
      try {
        checked(nodeExecutable, [cliEntry, 'daemon', 'install'], 'daemon recovery')
        startAndVerifyDaemon({
          run,
          platform,
          nodeExecutable,
          cliEntry,
          attempts: options.healthAttempts ?? 100,
          sleep,
        })
        daemonRestored = true
      } catch {
        daemonRestored = false
      }
    }
    throw new Error(
      `Fishbowl update failed during ${phase}. ${
        !daemonDowntimeStarted
          ? 'The running daemon was not changed.'
          : daemonRestored
            ? 'The previous CLI and daemon were restored.'
            : 'Daemon recovery requires manual attention.'
      } Rerun fishbowl update; if unavailable, run: npm ci, npm run build, npm link, fishbowl daemon install`,
    )
  }

  return {
    updated: sourceUpdateRequired,
    deploymentRefreshed: true,
    previousRevision,
    currentRevision,
    branch: 'main',
  }
}

function startAndVerifyDaemon(options: {
  run: (file: string, args: string[], output?: 'capture' | 'inherit') => UpdateCommandResult
  platform: 'darwin' | 'win32'
  nodeExecutable: string
  cliEntry: string
  attempts: number
  sleep: (milliseconds: number) => void
}): void {
  if (options.platform === 'win32') {
    const started = options.run(options.nodeExecutable, [options.cliEntry, 'project', 'list'])
    if (started.status !== 0) throw new Error('Command failed during daemon startup')
  }
  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    const doctor = options.run(options.nodeExecutable, [options.cliEntry, 'daemon', 'doctor'])
    if (doctor.status === 0) return
    if (attempt + 1 < options.attempts) options.sleep(25)
  }
  throw new Error('Command failed during health check')
}

function checkedNpm(
  run: (file: string, args: string[], output?: 'capture' | 'inherit') => UpdateCommandResult,
  platform: NodeJS.Platform,
  args: string[],
  stage: string,
): void {
  const invocation = platform === 'win32'
    ? { file: 'cmd.exe', args: ['/d', '/s', '/c', 'npm.cmd', ...args] }
    : { file: 'npm', args }
  const result = run(invocation.file, invocation.args, 'inherit')
  if (result.status !== 0) throw new Error(`Command failed during ${stage}`)
}

function normalizePath(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/\/$/, '').toLowerCase()
}

function fileDeploymentStore(sourceRoot: string): UpdateDeploymentStore {
  const distribution = join(sourceRoot, 'dist')
  const backup = join(sourceRoot, 'target', 'fishbowl-update-dist-backup')
  const preparing = `${backup}-preparing`
  const marker = join(distribution, '.fishbowl-deployed-revision')
  return {
    readRevision() {
      try {
        return readFileSync(marker, 'utf8').trim() || undefined
      } catch {
        return undefined
      }
    },
    prepareBackup() {
      mkdirSync(dirname(backup), { recursive: true })
      if (!existsSync(distribution)) throw new Error('Built Fishbowl distribution is missing')
      rmSync(preparing, { recursive: true, force: true })
      cpSync(distribution, preparing, { recursive: true })
      rmSync(backup, { recursive: true, force: true })
      renameSync(preparing, backup)
    },
    restoreBackup() {
      if (!existsSync(backup)) return false
      rmSync(distribution, { recursive: true, force: true })
      cpSync(backup, distribution, { recursive: true })
      rmSync(backup, { recursive: true, force: true })
      return true
    },
    commit(revision) {
      mkdirSync(distribution, { recursive: true })
      const temporary = `${marker}.tmp`
      writeFileSync(temporary, `${revision}\n`, { mode: 0o600 })
      renameSync(temporary, marker)
      rmSync(backup, { recursive: true, force: true })
    },
  }
}

function synchronousSleep(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(signal, 0, 0, milliseconds)
}

const systemRunner: UpdateCommandRunner = ({ file, args, cwd, output }) => {
  const result = spawnSync(file, args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    stdio: output === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) throw result.error
  return {
    status: result.status ?? 1,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
  }
}
