import Database from 'better-sqlite3'
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { resolveDaemonPaths, type DaemonPaths } from './config.js'

export type LegacyMigrationResult =
  | { migrated: true; sourcePath: string; backupPath?: string }
  | { migrated: false; reason: 'not-default-destination' | 'legacy-missing' | 'legacy-empty' | 'destination-populated' }

export async function migrateLegacyDatabaseIfNeeded(options: {
  paths: DaemonPaths
  home: string
  platform?: NodeJS.Platform
}): Promise<LegacyMigrationResult> {
  const platform = options.platform ?? process.platform
  const defaultPaths = resolveDaemonPaths({ platform, home: options.home, environment: {} })
  if (resolve(options.paths.databasePath) !== resolve(defaultPaths.databasePath)) {
    return { migrated: false, reason: 'not-default-destination' }
  }
  const sourcePath = join(options.home, '.engineering-knowledge-graph', 'data', 'knowledge.db')
  if (resolve(sourcePath) === resolve(options.paths.databasePath) || !existsSync(sourcePath)) {
    return { migrated: false, reason: 'legacy-missing' }
  }
  if (projectCount(sourcePath) === 0) return { migrated: false, reason: 'legacy-empty' }
  if (existsSync(options.paths.databasePath) && projectCount(options.paths.databasePath) > 0) {
    return { migrated: false, reason: 'destination-populated' }
  }

  mkdirSync(options.paths.dataDirectory, { recursive: true, mode: 0o700 })
  const temporaryPath = `${options.paths.databasePath}.legacy-migration.tmp`
  rmSync(temporaryPath, { force: true })
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true })
  try {
    await source.backup(temporaryPath)
  } finally {
    source.close()
  }
  if (process.platform !== 'win32') chmodSync(temporaryPath, 0o600)

  let backupPath: string | undefined
  try {
    if (existsSync(options.paths.databasePath)) {
      backupPath = `${options.paths.databasePath}.pre-legacy-migration-${Date.now()}.bak`
      renameSync(options.paths.databasePath, backupPath)
    }
    rmSync(`${options.paths.databasePath}-wal`, { force: true })
    rmSync(`${options.paths.databasePath}-shm`, { force: true })
    renameSync(temporaryPath, options.paths.databasePath)
  } catch (error) {
    rmSync(temporaryPath, { force: true })
    if (backupPath && !existsSync(options.paths.databasePath) && existsSync(backupPath)) {
      renameSync(backupPath, options.paths.databasePath)
    }
    throw error
  }
  return { migrated: true, sourcePath, backupPath }
}

function projectCount(path: string): number {
  const database = new Database(path, { readonly: true, fileMustExist: true })
  try {
    const table = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'",
    ).get()
    if (!table) return 0
    return (database.prepare('SELECT count(*) AS count FROM projects').get() as { count: number }).count
  } finally {
    database.close()
  }
}
