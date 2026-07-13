import Database from 'better-sqlite3'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { schemaMigrations, schemaVersion } from './schema.js'

export const DATABASE_BUSY_TIMEOUT_MS = 5_000
export const EKG_APPLICATION_ID = 0x454b4701

const CORRUPT_DATABASE_MESSAGE = 'EKG entered read-only recovery mode because the database is corrupt or unreadable. The database was not replaced. Create a backup of knowledge.db before recovery, run `sqlite3 knowledge.db ".recover" > recovered.sql`, restore into a separate data directory, then run `ekg integrity` and `ekg export`.'

function inspectExistingDatabase(path: string): void {
  if (path === ':memory:' || !existsSync(path)) return

  let database: Database.Database | undefined
  try {
    database = new Database(path, { readonly: true, fileMustExist: true })
    const rows = database.pragma('quick_check') as Array<{ quick_check: string }>
    if (!rows.every((row) => row.quick_check === 'ok')) {
      throw new Error(CORRUPT_DATABASE_MESSAGE)
    }
    const currentVersion = database.pragma('user_version', { simple: true }) as number
    if (currentVersion > schemaVersion) {
      throw new Error(
        `EKG entered read-only recovery mode: database uses newer schema version ${currentVersion}; this build supports ${schemaVersion}. The database was not replaced. Create a backup of knowledge.db, use a compatible newer EKG build to run \`ekg export\`, then import that archive with this build if needed.`,
      )
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('EKG entered read-only recovery mode')) {
      throw error
    }
    throw new Error(CORRUPT_DATABASE_MESSAGE)
  } finally {
    database?.close()
  }
}

export function openDatabase(path: string): Database.Database {
  const isNewDatabase = path !== ':memory:' && !existsSync(path)
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    chmodSync(dirname(path), 0o700)
  }
  inspectExistingDatabase(path)

  const database = new Database(path)
  try {
    if (path !== ':memory:') chmodSync(path, 0o600)
    database.pragma(`busy_timeout = ${DATABASE_BUSY_TIMEOUT_MS}`)
    database.pragma('journal_mode = WAL')
    if (path !== ':memory:') {
      for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
        if (existsSync(sidecar)) chmodSync(sidecar, 0o600)
      }
    }
    database.pragma('foreign_keys = ON')

    const currentVersion = database.pragma('user_version', {
      simple: true,
    }) as number
    if (currentVersion > schemaVersion) {
      throw new Error(
        `Database uses newer schema version ${currentVersion}; this build supports ${schemaVersion}`,
      )
    }

    database.transaction(() => {
      for (let index = currentVersion; index < schemaMigrations.length; index += 1) {
        database.exec(schemaMigrations[index] as string)
        database.pragma(`user_version = ${index + 1}`)
      }
    })()
    if (isNewDatabase) database.pragma(`application_id = ${EKG_APPLICATION_ID}`)
    return database
  } catch (error) {
    database.close()
    throw error
  }
}

export function closeDatabase(database: Database.Database): void {
  database.close()
}
