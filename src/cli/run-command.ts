import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants as osConstants } from 'node:os'
import { relative, resolve } from 'node:path'
import type { Writable } from 'node:stream'

import type { AwaitableKnowledgeBackend } from '../application/backend.js'
import type { RawLogResult } from '../logs/raw-log-store.js'

const BLOCKED_EXIT_CODE = 78
const COMMAND_NOT_FOUND_EXIT_CODE = 127
const NOT_EXECUTABLE_EXIT_CODE = 126
const MAX_CAPTURED_EXCERPT_BYTES = 64 * 1024
const MAX_STORED_EXCERPT_BYTES = 8 * 1024
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const

export interface RunCommandOptions {
  service: AwaitableKnowledgeBackend
  rawLogs: { open(projectId: string): RawLogWriter }
  projectId: string
  taskDescription: string
  changedFiles?: string[]
  argv: string[]
  cwd: string
  caseId?: string
  attemptId?: string
  stdout?: Writable
  stderr?: Writable
  warn?: (message: string) => void
}

interface RawLogWriter {
  write(bytes: Uint8Array): void
  close(): RawLogResult
}

export interface RunCommandResult {
  exitCode: number
  signal: NodeJS.Signals | null
  blocked: boolean
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function spawnErrorExitCode(error: NodeJS.ErrnoException): number {
  return error.code === 'EACCES' || error.code === 'EPERM'
    ? NOT_EXECUTABLE_EXIT_CODE
    : COMMAND_NOT_FOUND_EXIT_CODE
}

function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + (osConstants.signals[signal] ?? 0)
}

function isInside(path: string, roots: string[]): boolean {
  const candidate = resolve(path)
  return roots.some((root) => {
    const pathFromRoot = relative(resolve(root), candidate)
    return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !pathFromRoot.startsWith('/'))
  })
}

function boundedExcerpt(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value)
  if (bytes.byteLength <= maxBytes) return value
  const suffix = Buffer.from('\n[TRUNCATED]')
  return Buffer.concat([bytes.subarray(0, maxBytes - suffix.byteLength), suffix]).toString('utf8')
}

export async function runCommand(options: RunCommandOptions): Promise<RunCommandResult> {
  if (options.argv.length === 0 || options.argv.some((part) => part.length === 0)) {
    throw new Error('argv must contain a command and non-empty arguments')
  }
  const warn = options.warn ?? ((message: string) => process.stderr.write(`Warning: ${message}\n`))
  const resolved = await options.service.resolveProject({ projectId: options.projectId })
  const project = { projectId: resolved.id }
  const selected = (await options.service.listProjects()).find((candidate) => candidate.id === resolved.id)
  const roots = selected ? [selected.root, ...selected.aliases.map((alias) => alias.root)] : [resolved.root]
  if (!isInside(options.cwd, roots)) {
    throw new Error('cwd must be inside the selected project canonical root or alias')
  }
  const preflight = await options.service.preflight({
    project,
    taskDescription: options.taskDescription,
    changedFiles: options.changedFiles ?? [],
    command: options.argv,
  })
  if (preflight.blocked) {
    return { exitCode: BLOCKED_EXIT_CODE, signal: null, blocked: true }
  }

  const commandRunId = randomUUID()
  const startedAt = new Date()
  try {
    await options.service.recordCommandStarted({
      project,
      commandRunId,
      command: options.argv,
      workingDirectory: options.cwd,
      startedAt: startedAt.toISOString(),
    })
  } catch (error) {
    warn(`command start recording failed: ${errorMessage(error)}`)
  }

  let log: RawLogWriter | undefined
  try {
    log = options.rawLogs.open(resolved.id)
  } catch (error) {
    warn(`raw log unavailable: ${errorMessage(error)}`)
  }

  const excerptChunks: Buffer[] = []
  let excerptBytes = 0
  let logWritable = true
  const capture = (bytes: Buffer, destination: Writable | undefined) => {
    try {
      destination?.write(bytes)
    } catch (error) {
      warn(`terminal output failed: ${errorMessage(error)}`)
    }
    if (log && logWritable) {
      try {
        log.write(bytes)
      } catch (error) {
        logWritable = false
        warn(`raw log write failed: ${errorMessage(error)}`)
      }
    }
    if (excerptBytes < MAX_CAPTURED_EXCERPT_BYTES) {
      const selected = bytes.subarray(0, MAX_CAPTURED_EXCERPT_BYTES - excerptBytes)
      excerptChunks.push(Buffer.from(selected))
      excerptBytes += selected.byteLength
    }
  }

  const started = Date.now()
  const child = spawn(options.argv[0] as string, options.argv.slice(1), {
    cwd: options.cwd,
    shell: false,
    stdio: ['inherit', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (bytes: Buffer) => capture(bytes, options.stdout ?? process.stdout))
  child.stderr.on('data', (bytes: Buffer) => capture(bytes, options.stderr ?? process.stderr))

  const signalHandlers = new Map<NodeJS.Signals, () => void>()
  if (process.platform !== 'win32') {
    for (const signal of FORWARDED_SIGNALS) {
      const handler = () => child.kill(signal)
      signalHandlers.set(signal, handler)
      process.on(signal, handler)
    }
  }

  const outcome = await new Promise<{ code: number; signal: NodeJS.Signals | null }>((resolve) => {
    let spawnError: NodeJS.ErrnoException | undefined
    child.once('error', (error: NodeJS.ErrnoException) => { spawnError = error })
    child.once('close', (code, signal) => {
      resolve({
        code: spawnError
          ? spawnErrorExitCode(spawnError)
          : code ?? (signal ? signalExitCode(signal) : 1),
        signal,
      })
    })
  })
  for (const [signal, handler] of signalHandlers) process.off(signal, handler)

  let rawLogPath: string | null = null
  let rawLogDigest: string | null = null
  if (log) {
    try {
      const raw = log.close()
      if (logWritable) {
        rawLogPath = JSON.stringify(raw.paths)
        rawLogDigest = raw.digest
      }
    } catch (error) {
      warn(`raw log finalization failed: ${errorMessage(error)}`)
    }
  }

  const finishedAt = new Date()
  try {
    const commandResult = await options.service.recordCommandResult({
      project,
      commandRunId,
      caseId: options.caseId,
      attemptId: options.attemptId,
      command: options.argv,
      workingDirectory: options.cwd,
      exitStatus: outcome.signal ? null : outcome.code,
      signal: outcome.signal,
      durationMs: Math.max(0, Date.now() - started),
      excerpt: boundedExcerpt(
        Buffer.concat(excerptChunks).toString('utf8'),
        MAX_STORED_EXCERPT_BYTES,
      ),
      rawLogPath,
      rawLogDigest,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
    })
    if (outcome.code !== 0 || outcome.signal) {
      const excerpt = boundedExcerpt(
        Buffer.concat(excerptChunks).toString('utf8') || `Command exited ${outcome.code}`,
        MAX_STORED_EXCERPT_BYTES,
      )
      const fingerprintKey = createHash('sha256').update(excerpt).digest('hex')
      const problem = await options.service.recordProblem({
        project,
        sourceKey: { kind: 'command-fingerprint', key: fingerprintKey },
        data: {
          summary: `Command failed: ${options.argv[0]}`,
          symptoms: [excerpt],
          domain: 'command',
          fingerprint: fingerprintKey,
        },
      })
      await options.service.recordAttempt({
        project,
        caseId: problem.caseId,
        problemId: problem.nodeId,
        sourceKey: { kind: 'command-run', key: commandResult.commandRunId },
        data: {
          hypothesis: 'Unclassified command failure',
          change: `Ran ${options.argv.join(' ')}`,
          outcome: 'failed',
          command: options.argv,
          failureExplanation: excerpt,
        },
      })
    }
  } catch (error) {
    warn(`knowledge recording failed: ${errorMessage(error)}`)
  }

  return { exitCode: outcome.code, signal: outcome.signal, blocked: false }
}
