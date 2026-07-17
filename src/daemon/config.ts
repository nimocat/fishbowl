import { randomBytes as systemRandomBytes, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

export const DAEMON_PROTOCOL_VERSION = 2 as const

export interface DaemonPaths {
  dataDirectory: string
  databasePath: string
  descriptorFile: string
  tokenFile: string
  pidFile: string
  logFile: string
}

export interface DaemonDescriptor {
  protocolVersion: typeof DAEMON_PROTOCOL_VERSION
  daemonVersion: string
  host: '127.0.0.1'
  port: number
  browserPort?: number
  instanceId: string
  pid: number
  startedAt: string
}

export interface ResolveDaemonPathsOptions {
  platform: NodeJS.Platform
  home: string
  environment: Record<string, string | undefined>
}

export function resolveDaemonPaths(options: ResolveDaemonPathsOptions): DaemonPaths {
  const override = options.environment.FISHBOWL_DATA_DIR?.trim()
  const dataDirectory = override || (
    options.platform === 'darwin'
      ? join(options.home, 'Library', 'Application Support', 'Fishbowl')
      : options.platform === 'win32'
        ? join(options.environment.LOCALAPPDATA || join(options.home, 'AppData', 'Local'), 'Fishbowl')
        : join(options.environment.XDG_DATA_HOME || join(options.home, '.local', 'share'), 'fishbowl')
  )
  return {
    dataDirectory,
    databasePath: join(dataDirectory, 'knowledge.db'),
    descriptorFile: join(dataDirectory, 'daemon.json'),
    tokenFile: join(dataDirectory, 'daemon.token'),
    pidFile: join(dataDirectory, 'daemon.pid'),
    logFile: join(dataDirectory, 'daemon.log'),
  }
}

/**
 * Moves the former product store to Fishbowl's branded location before a new
 * credential or descriptor is created. Renaming a sibling directory is atomic
 * on supported local filesystems, so the database, WAL sidecars, and raw logs
 * remain a single consistent store. Explicit Fishbowl data directories are
 * never migrated or overwritten.
 */
export function migrateLegacyDataDirectory(options: ResolveDaemonPathsOptions): { migrated: boolean; source?: string } {
  if (options.environment.FISHBOWL_DATA_DIR?.trim()) return { migrated: false }

  const destination = resolveDaemonPaths(options).dataDirectory
  if (existsSync(destination)) return { migrated: false }

  const source = legacyDataDirectory(options)
  if (source === destination || !existsSync(join(source, 'knowledge.db'))) return { migrated: false }

  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
  renameSync(source, destination)
  return { migrated: true, source }
}

export function ensureDaemonCredentials(options: {
  paths: DaemonPaths
  randomBytes?: (size: number) => Buffer
}): { token: string } {
  ensurePrivateDirectory(options.paths.dataDirectory)
  if (!existsSync(options.paths.tokenFile)) {
    const token = (options.randomBytes ?? systemRandomBytes)(32).toString('hex')
    writeFileSync(options.paths.tokenFile, token, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  }
  if (process.platform !== 'win32') chmodSync(options.paths.tokenFile, 0o600)
  return { token: readFileSync(options.paths.tokenFile, 'utf8').trim() }
}

export function writeDaemonDescriptor(paths: DaemonPaths, descriptor: DaemonDescriptor): void {
  ensurePrivateDirectory(paths.dataDirectory)
  const temporary = `${paths.descriptorFile}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(descriptor)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    renameSync(temporary, paths.descriptorFile)
    if (process.platform !== 'win32') chmodSync(paths.descriptorFile, 0o600)
  } catch (error) {
    try {
      if (existsSync(temporary)) chmodSync(temporary, 0o600)
    } catch {
      // Preserve the original atomic-write failure.
    }
    throw error
  }
}

export function readDaemonDescriptor(options: { paths: DaemonPaths }): DaemonDescriptor {
  const value = JSON.parse(readFileSync(options.paths.descriptorFile, 'utf8')) as Partial<DaemonDescriptor>
  if (
    value.protocolVersion !== DAEMON_PROTOCOL_VERSION ||
    typeof value.daemonVersion !== 'string' ||
    value.host !== '127.0.0.1' ||
    !Number.isInteger(value.port) || (value.port ?? 0) < 1 || (value.port ?? 0) > 65_535 ||
    (value.browserPort !== undefined && (!Number.isInteger(value.browserPort) || value.browserPort < 1 || value.browserPort > 65_535)) ||
    typeof value.instanceId !== 'string' || !value.instanceId ||
    !Number.isInteger(value.pid) || (value.pid ?? 0) < 1 ||
    typeof value.startedAt !== 'string' || !value.startedAt
  ) {
    throw new Error('Invalid Fishbowl daemon descriptor')
  }
  return value as DaemonDescriptor
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(path, 0o700)
}

function legacyDataDirectory(options: ResolveDaemonPathsOptions): string {
  if (options.platform === 'darwin') {
    return join(options.home, 'Library', 'Application Support', 'EKG')
  }
  if (options.platform === 'win32') {
    return join(options.environment.LOCALAPPDATA || join(options.home, 'AppData', 'Local'), 'EKG')
  }
  return join(options.environment.XDG_DATA_HOME || join(options.home, '.local', 'share'), 'ekg')
}
