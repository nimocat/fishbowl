import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import type { KnowledgeServiceContract, RecordCommandResultInput } from '../../src/application/contracts.js'
import { runCommand } from '../../src/cli/run-command.js'
import { RawLogStore } from '../../src/logs/raw-log-store.js'

const helper = fileURLToPath(new URL('./helpers/command-child.mjs', import.meta.url))

class ByteSink extends Writable {
  readonly chunks: Buffer[] = []

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.from(chunk))
    callback()
  }

  bytes(): Buffer {
    return Buffer.concat(this.chunks)
  }
}

function encoded(value: string): string {
  return Buffer.from(value).toString('base64')
}

describe('runCommand', () => {
  const sandboxes: string[] = []

  function harness(overrides: {
    blocked?: boolean
    recordError?: Error
  } = {}): {
    directory: string
    service: KnowledgeServiceContract
    records: RecordCommandResultInput[]
    preflights: unknown[]
    problems: unknown[]
    attempts: unknown[]
    starts: unknown[]
  } {
    const directory = mkdtempSync(join(tmpdir(), 'ekg-run-'))
    sandboxes.push(directory)
    const records: RecordCommandResultInput[] = []
    const preflights: unknown[] = []
    const problems: unknown[] = []
    const attempts: unknown[] = []
    const starts: unknown[] = []
    const service = {
      resolveProject: () => ({ id: 'project-a', root: directory, name: 'Project', description: null, createdAt: '' }),
      listProjects: () => [{ id: 'project-a', root: directory, name: 'Project', description: null, createdAt: '', aliases: [] }],
      preflight: (input: unknown) => {
        preflights.push(input)
        return { blocked: overrides.blocked ?? false, guardrails: [], failedAttempts: [], rootCauses: [], solutions: [], uncertain: [] }
      },
      recordCommandResult: (input: RecordCommandResultInput) => {
        if (overrides.recordError) throw overrides.recordError
        records.push(input)
        return { commandRunId: 'run-a', created: true }
      },
      recordProblem: (input: unknown) => {
        problems.push(input)
        return { caseId: 'case-a', nodeId: 'problem-a', promotion: { status: 'candidate', missingRequirements: [] }, created: true }
      },
      recordAttempt: (input: unknown) => {
        attempts.push(input)
        return { caseId: 'case-a', nodeId: 'attempt-a', promotion: { status: 'candidate', missingRequirements: [] }, created: true }
      },
      recordCommandStarted: (input: unknown) => {
        starts.push(input)
        return { commandRunId: 'run-a' }
      },
    } as unknown as KnowledgeServiceContract
    return { directory, service, records, preflights, problems, attempts, starts }
  }

  async function execute(
    service: KnowledgeServiceContract,
    directory: string,
    argv: string[],
  ): Promise<{ result: Awaited<ReturnType<typeof runCommand>>; stdout: Buffer; stderr: Buffer; warnings: string[] }> {
    const stdout = new ByteSink()
    const stderr = new ByteSink()
    const warnings: string[] = []
    const result = await runCommand({
      service,
      rawLogs: new RawLogStore(directory),
      projectId: 'project-a',
      taskDescription: 'exercise child process',
      changedFiles: ['src/example.ts'],
      argv,
      cwd: directory,
      stdout,
      stderr,
      warn: (message) => warnings.push(message),
    })
    return { result, stdout: stdout.bytes(), stderr: stderr.bytes(), warnings }
  }

  afterEach(() => {
    for (const path of sandboxes.splice(0)) rmSync(path, { recursive: true, force: true })
  })

  it('spawns exact argv without a shell and tees stdout and stderr bytes separately', async () => {
    const { directory, service, records, preflights } = harness()
    const options = JSON.stringify({ stdout: encoded('out\u0000'), stderr: encoded('err\u00ff') })
    const invocation = [process.execPath, helper, options, 'space value', '$HOME', '"quoted"']

    const { result, stdout, stderr } = await execute(service, directory, invocation)

    expect(result).toMatchObject({ exitCode: 0, signal: null, blocked: false })
    expect(stdout).toEqual(Buffer.concat([Buffer.from('out\u0000'), Buffer.from('["space value","$HOME","\\"quoted\\""]\n')]))
    expect(stderr).toEqual(Buffer.from('err\u00ff'))
    expect(preflights).toEqual([expect.objectContaining({ command: invocation })])
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ command: invocation, exitStatus: 0, signal: null })
    expect(records[0]?.workingDirectory).toBe(directory)
    expect(records[0]?.rawLogDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(records[0]?.rawLogPath).toContain(join(directory, 'logs', 'project-a'))
    expect(records[0]).not.toHaveProperty('rawLogArtifact')
    const rawBytes = Buffer.concat(JSON.parse(records[0]?.rawLogPath as string).map((path: string) => readFileSync(path)))
    expect(rawBytes.includes(Buffer.from('out\u0000'))).toBe(true)
    expect(rawBytes.includes(Buffer.from('["space value","$HOME","\\"quoted\\""]\n'))).toBe(true)
    expect(rawBytes.includes(Buffer.from('err\u00ff'))).toBe(true)
  })

  it('preserves nonzero, command-not-found, and non-executable exit codes', async () => {
    const first = harness()
    const nonzero = await execute(first.service, first.directory, [
      process.execPath, helper, JSON.stringify({ exitCode: 23 }),
    ])
    expect(nonzero.result.exitCode).toBe(23)

    const missing = harness()
    expect((await execute(missing.service, missing.directory, ['ekg-command-that-does-not-exist'])).result.exitCode)
      .toBe(127)

    if (process.platform !== 'win32') {
      const denied = harness()
      const file = join(denied.directory, 'not-executable')
      writeFileSync(file, '#!/bin/sh\nexit 0\n')
      chmodSync(file, 0o600)
      expect((await execute(denied.service, denied.directory, [file])).result.exitCode).toBe(126)
    }
  })

  it('returns 78 for a verified block before spawning the child', async () => {
    const { directory, service, records } = harness({ blocked: true })
    const marker = join(directory, 'spawned')

    const { result } = await execute(service, directory, [
      process.execPath, helper, JSON.stringify({ marker }),
    ])

    expect(result).toMatchObject({ exitCode: 78, blocked: true })
    expect(() => readFileSync(marker)).toThrow()
    expect(records).toHaveLength(0)
  })

  it('rejects a cwd outside the selected project before opening raw logs or spawning', async () => {
    const { directory, service, records, preflights } = harness()
    const outside = mkdtempSync(join(tmpdir(), 'ekg-run-outside-'))
    sandboxes.push(outside)
    let opened = false

    await expect(runCommand({
      service,
      rawLogs: { open: () => { opened = true; throw new Error('must not open') } },
      projectId: 'project-a',
      taskDescription: 'outside cwd',
      argv: [process.execPath, helper, '{}'],
      cwd: outside,
    })).rejects.toThrow(/cwd.*selected project/i)
    expect(opened).toBe(false)
    expect(preflights).toEqual([])
    expect(records).toEqual([])
  })

  it('warns and preserves the child result when knowledge recording fails', async () => {
    const { directory, service } = harness({ recordError: new Error('database unavailable') })

    const { result, warnings } = await execute(service, directory, [
      process.execPath, helper, JSON.stringify({ exitCode: 0 }),
    ])

    expect(result.exitCode).toBe(0)
    expect(warnings).toEqual([expect.stringMatching(/database unavailable/)])
  })

  it('warns and omits incomplete metadata when raw-log writing fails', async () => {
    const { directory, service, records } = harness()
    const warnings: string[] = []

    const result = await runCommand({
      service,
      rawLogs: {
        open: () => ({
          write: () => { throw new Error('disk full') },
          close: () => ({
            digest: 'invalid-digest',
            byteSize: 1,
            paths: ['/incomplete.log'],
            truncated: false,
            artifact: {
              kind: 'command-log',
              digestAlgorithm: 'sha256',
              digest: 'invalid-digest',
              byteSize: 1,
              retainedByteSize: 1,
              paths: ['/incomplete.log'],
              segmentCount: 1,
              truncated: false,
            },
          }),
        }),
      },
      projectId: 'project-a',
      taskDescription: 'raw log failure',
      argv: [process.execPath, helper, JSON.stringify({ stdout: encoded('output') })],
      cwd: directory,
      stdout: new ByteSink(),
      stderr: new ByteSink(),
      warn: (message) => warnings.push(message),
    })

    expect(result.exitCode).toBe(0)
    expect(warnings).toEqual([expect.stringMatching(/disk full/)])
    expect(records[0]).toMatchObject({ rawLogPath: null, rawLogDigest: null })
    expect(records[0]).not.toHaveProperty('rawLogArtifact')
  })

  it('sends only a bounded excerpt to the Rust redaction boundary and never environment values', async () => {
    const { directory, service, records } = harness()
    const secret = 'token=super-secret-value'
    const environmentSecret = 'environment-only-secret'
    process.env.EKG_RUN_TEST_SECRET = environmentSecret
    const output = `${secret}\n${'x'.repeat(20_000)}`

    await execute(service, directory, [
      process.execPath, helper, JSON.stringify({ stdout: encoded(output) }),
    ])

    delete process.env.EKG_RUN_TEST_SECRET
    expect(records[0]?.excerpt).toContain(secret)
    expect(records[0]?.excerpt).not.toContain(environmentSecret)
    expect(Buffer.byteLength(records[0]?.excerpt as string)).toBeLessThanOrEqual(8 * 1024)
  })

  it('captures a failed command as a deduplicated candidate Problem and failed Attempt', async () => {
    const { directory, service, problems, attempts, starts } = harness()
    await execute(service, directory, [
      process.execPath, helper, JSON.stringify({ stderr: encoded('Error at /tmp/file.ts:42 token=secret'), exitCode: 2 }),
      '--token', 'argv-secret',
    ])

    expect(problems).toEqual([expect.objectContaining({
      sourceKey: expect.objectContaining({ kind: 'command-fingerprint' }),
      data: expect.objectContaining({ fingerprint: expect.not.stringContaining('secret') }),
    })])
    expect(attempts).toEqual([expect.objectContaining({
      sourceKey: { kind: 'command-run', key: 'run-a' },
      data: expect.objectContaining({ outcome: 'failed', command: expect.arrayContaining(['argv-secret']) }),
    })])
    expect(starts).toEqual([expect.objectContaining({ command: expect.any(Array) })])
  })
})
