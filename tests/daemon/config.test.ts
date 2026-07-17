import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  ensureDaemonCredentials,
  readDaemonDescriptor,
  resolveDaemonPaths,
  writeDaemonDescriptor,
} from '../../src/daemon/config.js'

describe('daemon configuration', () => {
  const sandboxes: string[] = []

  afterEach(() => {
    for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true })
  })

  it('uses platform data locations and honors EKG_DATA_DIR', () => {
    expect(resolveDaemonPaths({
      platform: 'darwin',
      home: '/Users/tester',
      environment: {},
    }).dataDirectory).toBe('/Users/tester/Library/Application Support/EKG')

    expect(resolveDaemonPaths({
      platform: 'win32',
      home: 'C:\\Users\\tester',
      environment: { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' },
    }).dataDirectory).toBe('C:\\Users\\tester\\AppData\\Local/EKG')

    expect(resolveDaemonPaths({
      platform: 'linux',
      home: '/home/tester',
      environment: { EKG_DATA_DIR: '/var/tmp/ekg-test' },
    }).dataDirectory).toBe('/var/tmp/ekg-test')
  })

  it('creates an owner-only token and atomically stores a public descriptor', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'ekg-daemon-config-'))
    sandboxes.push(sandbox)
    const paths = resolveDaemonPaths({
      platform: process.platform,
      home: sandbox,
      environment: { EKG_DATA_DIR: join(sandbox, 'data') },
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

  it('rejects a descriptor from the retired protocol generation', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'ekg-daemon-stale-config-'))
    sandboxes.push(sandbox)
    const paths = resolveDaemonPaths({
      platform: process.platform,
      home: sandbox,
      environment: { EKG_DATA_DIR: join(sandbox, 'data') },
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
})
