import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  ensureDaemonCredentials,
  ensureDaemonPort,
  migrateLegacyDataDirectory,
  readDaemonDescriptor,
  resolveDaemonPaths,
  writeDaemonDescriptor,
} from '../../src/daemon/config.js'

describe('daemon configuration', () => {
  const sandboxes: string[] = []

  afterEach(() => {
    for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true })
  })

  it('uses platform data locations and honors FISHBOWL_DATA_DIR', () => {
    expect(resolveDaemonPaths({
      platform: 'darwin',
      home: '/Users/tester',
      environment: {},
    }).dataDirectory).toBe('/Users/tester/Library/Application Support/Fishbowl')

    expect(resolveDaemonPaths({
      platform: 'win32',
      home: 'C:\\Users\\tester',
      environment: { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' },
    }).dataDirectory).toBe('C:\\Users\\tester\\AppData\\Local/Fishbowl')

    expect(resolveDaemonPaths({
      platform: 'linux',
      home: '/home/tester',
      environment: { FISHBOWL_DATA_DIR: '/var/tmp/fishbowl-test' },
    }).dataDirectory).toBe('/var/tmp/fishbowl-test')
  })

  it('creates an owner-only token and atomically stores a public descriptor', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'fishbowl-daemon-config-'))
    sandboxes.push(sandbox)
    const paths = resolveDaemonPaths({
      platform: process.platform,
      home: sandbox,
      environment: { FISHBOWL_DATA_DIR: join(sandbox, 'data') },
    })
    mkdirSync(paths.dataDirectory, { recursive: true })

    const credentials = ensureDaemonCredentials({
      paths,
      randomBytes: (size) => Buffer.alloc(size, 7),
    })

    expect(credentials.token).toBe(Buffer.alloc(32, 7).toString('hex'))
    expect(readFileSync(paths.tokenFile, 'utf8')).toBe(credentials.token)
    if (process.platform !== 'win32') {
      expect(statSync(paths.tokenFile).mode & 0o077).toBe(0)
    }

    const descriptor = {
      protocolVersion: 2 as const,
      daemonVersion: '0.1.0',
      host: '127.0.0.1' as const,
      port: 4317,
      instanceId: randomBytes(8).toString('hex'),
      pid: 123,
      startedAt: '2026-07-15T00:00:00.000Z',
    }
    writeDaemonDescriptor(paths, descriptor)

    expect(readDaemonDescriptor({ paths })).toEqual(descriptor)
    expect(JSON.parse(readFileSync(paths.descriptorFile, 'utf8'))).not.toHaveProperty('token')
  })

  it('persists one owner-only user port and reuses it across daemon restarts', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'fishbowl-daemon-port-'))
    sandboxes.push(sandbox)
    const paths = resolveDaemonPaths({
      platform: process.platform,
      home: sandbox,
      environment: { FISHBOWL_DATA_DIR: join(sandbox, 'data') },
    })

    const first = ensureDaemonPort({ paths, randomBytes: () => Buffer.from([0x12, 0x34]) })
    const second = ensureDaemonPort({ paths, randomBytes: () => Buffer.from([0xff, 0xff]) })

    expect(first).toBe(49_152 + (0x1234 % 16_384))
    expect(second).toBe(first)
    expect(readFileSync(paths.portFile, 'utf8')).toBe(`${first}\n`)
    if (process.platform !== 'win32') {
      expect(statSync(paths.portFile).mode & 0o077).toBe(0)
    }
  })

  it('adopts the last valid daemon descriptor port during a compatible upgrade', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'fishbowl-daemon-port-upgrade-'))
    sandboxes.push(sandbox)
    const paths = resolveDaemonPaths({
      platform: process.platform,
      home: sandbox,
      environment: { FISHBOWL_DATA_DIR: join(sandbox, 'data') },
    })
    writeDaemonDescriptor(paths, {
      protocolVersion: 2,
      daemonVersion: '0.1.0',
      host: '127.0.0.1',
      port: 56_341,
      instanceId: 'upgrade-instance',
      pid: 123,
      startedAt: '2026-07-18T00:00:00.000Z',
    })

    expect(ensureDaemonPort({ paths, randomBytes: () => Buffer.from([0, 0]) })).toBe(56_341)
    expect(readFileSync(paths.portFile, 'utf8')).toBe('56341\n')
  })

  it('rejects an invalid persisted port instead of silently changing daemon identity', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'fishbowl-daemon-invalid-port-'))
    sandboxes.push(sandbox)
    const paths = resolveDaemonPaths({
      platform: process.platform,
      home: sandbox,
      environment: { FISHBOWL_DATA_DIR: join(sandbox, 'data') },
    })
    mkdirSync(paths.dataDirectory, { recursive: true })
    writeFileSync(paths.portFile, '0\n')

    expect(() => ensureDaemonPort({ paths })).toThrow(/invalid.*daemon port.*daemon\.port/i)
  })

  it('rejects a descriptor from the retired protocol generation', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'fishbowl-daemon-stale-config-'))
    sandboxes.push(sandbox)
    const paths = resolveDaemonPaths({
      platform: process.platform,
      home: sandbox,
      environment: { FISHBOWL_DATA_DIR: join(sandbox, 'data') },
    })
    mkdirSync(paths.dataDirectory, { recursive: true })
    writeFileSync(paths.descriptorFile, JSON.stringify({
      protocolVersion: 1,
      daemonVersion: '0.1.0',
      host: '127.0.0.1',
      port: 4317,
      instanceId: 'retired-v1',
      pid: 123,
      startedAt: '2026-07-15T00:00:00.000Z',
    }))

    expect(() => readDaemonDescriptor({ paths })).toThrow(/invalid.*descriptor/i)
  })

  it('atomically relocates a populated legacy store before Fishbowl creates state', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'fishbowl-legacy-migration-'))
    sandboxes.push(sandbox)
    const legacyDirectory = join(sandbox, 'Library', 'Application Support', 'EKG')
    mkdirSync(legacyDirectory, { recursive: true })
    writeFileSync(join(legacyDirectory, 'knowledge.db'), 'legacy-db')
    writeFileSync(join(legacyDirectory, 'daemon.token'), 'legacy-token')

    const options = { platform: 'darwin' as const, home: sandbox, environment: {} }
    expect(migrateLegacyDataDirectory(options)).toEqual({ migrated: true, source: legacyDirectory })

    const fishbowl = resolveDaemonPaths(options)
    expect(readFileSync(fishbowl.databasePath, 'utf8')).toBe('legacy-db')
    expect(readFileSync(fishbowl.tokenFile, 'utf8')).toBe('legacy-token')
    expect(existsSync(legacyDirectory)).toBe(false)
  })
})
