#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { Writable } from 'node:stream'

import type { AwaitableKnowledgeBackend } from '../application/backend.js'
import { ensureInstalledDaemon, initializeDaemonCredentials } from '../daemon/lifecycle.js'
import { DaemonClient } from '../daemon/client.js'
import { readDaemonDescriptor, type DaemonDescriptor, type DaemonPaths } from '../daemon/config.js'
import { defaultNativeBinary, installCurrentUserDaemon, nativeDaemonArguments, uninstallCurrentUserDaemon } from '../daemon/platform.js'
import { runStdioServer } from '../mcp/stdio.js'
import { RawLogStore } from '../logs/raw-log-store.js'
import { parseArguments, type CliCommand } from './arguments.js'
import { runCommand } from './run-command.js'
import { isDirectExecution } from './direct-execution.js'
import { updateFishbowl, type FishbowlUpdateResult } from './update.js'

interface OutputStream {
  write(value: string | Uint8Array): unknown
}

export interface CliDependencies {
  stdout?: OutputStream
  stderr?: OutputStream
  backend?: AwaitableKnowledgeBackend
  /** Test/process-owner hook; normal CLI daemons remain detached. */
  daemonDetached?: boolean
  update?: () => FishbowlUpdateResult
}

function printJson(stream: OutputStream, value: unknown): void {
  stream.write(`${JSON.stringify(value, null, 2)}\n`)
}

function project(projectId: string): { projectId: string } {
  return { projectId }
}

async function dispatch(service: AwaitableKnowledgeBackend, command: CliCommand): Promise<unknown> {
  switch (command.kind) {
    case 'project-register': return await service.registerProject({
      root: command.root,
      name: command.name,
      description: command.description,
    })
    case 'project-list': return await service.listProjects()
    case 'project-resolve': return await service.resolveProject({ projectId: command.projectId, projectRoot: command.projectRoot })
    case 'project-update': return await service.updateProject({ project: project(command.projectId), name: command.name, description: command.description, addAlias: command.addAlias })
    case 'query': return await service.queryKnowledge({ ...command.filters, project: project(command.projectId), text: command.text })
    case 'preflight': return await service.preflight({ project: project(command.projectId), taskDescription: command.taskDescription, command: command.command, changedFiles: command.changedFiles })
    case 'case-start': return await service.recordProblem({ project: project(command.projectId), caseTitle: command.caseTitle, data: command.data as never, operationId: command.operationId })
    case 'case-attempt': return await service.recordAttempt({ project: project(command.projectId), caseId: command.caseId, problemId: command.problemId, previousAttemptId: command.previousAttemptId, data: command.data as never, operationId: command.operationId })
    case 'case-root-cause': return await service.recordRootCause({ project: project(command.projectId), caseId: command.caseId, problemId: command.problemId, failedAttemptIds: command.failedAttemptIds, status: command.status, humanConfirmed: command.humanConfirmed, data: command.data as never, operationId: command.operationId })
    case 'case-solution': return await service.recordSolution({ project: project(command.projectId), caseId: command.caseId, rootCauseId: command.rootCauseId, data: command.data as never, operationId: command.operationId })
    case 'case-verify': return await service.recordVerification({ project: project(command.projectId), caseId: command.caseId, solutionId: command.solutionId, data: command.data as never, operationId: command.operationId })
    case 'case-close': return await service.closeCase({ project: project(command.projectId), caseId: command.caseId, operationId: command.operationId })
    case 'case-regress': return await service.markRegression({ project: project(command.projectId), caseId: command.caseId, solutionId: command.solutionId, fingerprint: command.fingerprint, observedContext: command.observedContext, operationId: command.operationId })
    case 'import-preview': return await service.previewImport({ project: project(command.projectId), sources: command.sources as never })
    case 'import-apply': return await service.applyImport({ project: project(command.projectId), previewId: command.previewId, proposalIds: command.proposalIds, operationId: command.operationId })
    case 'import-graph': return await service.importProjectGraph({ project: project(command.projectId), archive: JSON.parse(readFileSync(command.file, 'utf8')) as never, operationId: command.operationId })
    case 'export': return await service.exportProjectGraph({ project: project(command.projectId) })
    case 'activity': return await service.listRecentActivity({ project: project(command.projectId), afterSequence: command.afterSequence, limit: command.limit })
    case 'disk-start': return await service.startDiskObservation({ project: project(command.projectId), operationId: command.operationId, task: command.task })
    case 'disk-finish': return await service.finishDiskObservation({ project: project(command.projectId), operationId: command.operationId, observationId: command.observationId })
    case 'disk-list': return await service.listDiskObservations({ project: project(command.projectId), limit: command.limit })
    case 'disk-candidates': return await service.listCleanupCandidates({ project: project(command.projectId), limit: command.limit })
    case 'checkpoint': return await service.checkpointWork({
      ...(command.data as object),
      project: command.projectId ? { projectId: command.projectId } : { projectRoot: command.projectRoot },
      operationId: command.operationId ?? randomUUID(),
      task: command.task,
      outcome: command.outcome,
      summary: command.summary,
    })
    case 'run': throw new Error('run command requires asynchronous dispatch')
    default: throw new Error(`Command requires lifecycle handling: ${command.kind}`)
  }
}

async function runNativeIntegrity(
  environment: Record<string, string | undefined>,
  stdout: OutputStream,
  stderr: OutputStream,
): Promise<number> {
  const initialized = initializeDaemonCredentials({ environment })
  const child = spawn(defaultNativeBinary(), [
    'integrity', '--database', initialized.paths.databasePath,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (bytes: Buffer) => stdout.write(bytes))
  child.stderr.on('data', (bytes: Buffer) => stderr.write(bytes))
  return await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 1))
  })
}

export async function runCli(argv: string[], dependencies: CliDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout
  const stderr = dependencies.stderr ?? process.stderr
  try {
    const parsed = parseArguments(argv)
    const daemonEnvironment = parsed.embedded
      ? { ...process.env, FISHBOWL_DATA_DIR: parsed.dataDirectory }
      : process.env
    if (parsed.command.kind === 'update') {
      printJson(stdout, (dependencies.update ?? updateFishbowl)())
      return 0
    }
    if (parsed.command.kind === 'daemon') {
      const initialized = initializeDaemonCredentials({ environment: daemonEnvironment })
      if (parsed.command.action === 'install') {
        await stopInstalledDaemonIfRunning(initialized)
        printJson(stdout, installCurrentUserDaemon({ paths: initialized.paths }))
        return 0
      }
      if (parsed.command.action === 'uninstall') {
        printJson(stdout, uninstallCurrentUserDaemon())
        return 0
      }
      if (parsed.command.action === 'foreground') {
        const child = spawn(defaultNativeBinary(), nativeDaemonArguments(initialized.paths), {
          stdio: 'inherit',
        })
        return await new Promise<number>((resolve, reject) => {
          child.once('error', reject)
          child.once('exit', (code) => resolve(code ?? 1))
        })
      }
      let descriptor
      try { descriptor = readDaemonDescriptor({ paths: initialized.paths }) } catch {
        printJson(stdout, { running: false, guidance: 'Run `fishbowl daemon install` or any normal Fishbowl command.' })
        return parsed.command.action === 'doctor' ? 1 : 0
      }
      const running = (() => {
        try { process.kill(descriptor.pid, 0); return true } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'EPERM'
        }
      })()
      let healthy = false
      if (running && (parsed.command.action === 'doctor' || parsed.command.action === 'stop')) {
        try {
          const probe = new DaemonClient({ descriptor, token: initialized.token, timeoutMs: 500 })
          await probe.call('listProjects', {})
          healthy = true
        } catch {
          healthy = false
        }
      }
      if (parsed.command.action === 'stop' && running) {
        if (!healthy) {
          throw new Error('Refusing to stop a daemon PID that did not pass authenticated health validation')
        }
        process.kill(descriptor.pid, 'SIGTERM')
        await waitForProcessExit(descriptor.pid)
      }
      printJson(stdout, {
        running: parsed.command.action === 'stop' ? false : running,
        protocolVersion: descriptor.protocolVersion,
        daemonVersion: descriptor.daemonVersion,
        pid: descriptor.pid,
        port: descriptor.port,
        ...(descriptor.browserPort && { webUrl: `http://127.0.0.1:${descriptor.browserPort}` }),
        ...(parsed.command.action === 'doctor' && {
          healthy,
          dataDirectory: initialized.paths.dataDirectory,
          tokenPresent: initialized.token.length === 64,
        }),
      })
      if (parsed.command.action === 'doctor') return healthy ? 0 : 1
      return running || parsed.command.action === 'stop' ? 0 : 1
    }
    if (parsed.command.kind === 'mcp-stdio') {
      await runStdioServer({
        backend: dependencies.backend,
        dataDirectory: parsed.embedded ? parsed.dataDirectory : undefined,
      })
      return 0
    }
    if (parsed.command.kind === 'integrity') {
      return await runNativeIntegrity(daemonEnvironment, stdout, stderr)
    }
    const installed = dependencies.backend ? undefined : await ensureInstalledDaemon({
      environment: daemonEnvironment,
      detached: dependencies.daemonDetached,
    })
    if (parsed.command.kind === 'serve') {
      const descriptor = installed?.descriptor
      if (!descriptor?.browserPort) throw new Error('Native Trace Bench endpoint is unavailable')
      stdout.write(`http://127.0.0.1:${descriptor.browserPort}\n`)
      return 0
    }
    const service = dependencies.backend ?? installed?.backend
    if (!service) throw new Error('Native daemon backend is unavailable')
    if (parsed.command.kind === 'run') {
      const result = await runCommand({
        service,
        rawLogs: new RawLogStore(parsed.dataDirectory),
        projectId: parsed.command.projectId,
        taskDescription: parsed.command.taskDescription,
        changedFiles: parsed.command.changedFiles,
        argv: parsed.command.argv,
        cwd: process.cwd(),
        caseId: parsed.command.commandCaseId,
        attemptId: parsed.command.attemptId,
        stdout: stdout as Writable,
        stderr: stderr as Writable,
        warn: (message) => stderr.write(`Warning: ${message}\n`),
      })
      if (result.blocked) printJson(stderr, { blocked: true, exitCode: result.exitCode })
      return result.exitCode
    }
    const result = await dispatch(service, parsed.command)
    if (parsed.command.kind === 'export' && parsed.command.output) {
      writeFileSync(parsed.command.output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
      printJson(stdout, { output: parsed.command.output })
    } else printJson(stdout, result)
    return 0
  } catch (error) {
    const value = error instanceof Error
      ? { error: error.name, message: error.message }
      : { error: 'Error', message: String(error) }
    printJson(stderr, value)
    return 1
  }
}

export async function waitForProcessExit(pid: number, options: {
  timeoutMs?: number
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  signal?: (pid: number, signal: 0) => void
} = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 2_500
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const signal = options.signal ?? process.kill
  const deadline = now() + timeoutMs
  while (now() < deadline) {
    try {
      signal(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
    }
    await sleep(25)
  }
  throw new Error(`Fishbowl daemon did not stop within ${timeoutMs}ms`)
}

export async function stopInstalledDaemonIfRunning(
  initialized: { paths: DaemonPaths; token: string },
  options: {
    readDescriptor?: () => DaemonDescriptor
    signal?: (pid: number, signal: NodeJS.Signals | 0) => void
    authenticate?: (descriptor: DaemonDescriptor) => Promise<void>
    wait?: (pid: number) => Promise<void>
  } = {},
): Promise<boolean> {
  let descriptor: DaemonDescriptor
  try {
    descriptor = (options.readDescriptor ?? (() => readDaemonDescriptor({ paths: initialized.paths })))()
  } catch {
    return false
  }
  const signal = options.signal ?? process.kill
  try {
    signal(descriptor.pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
  }
  try {
    if (options.authenticate) await options.authenticate(descriptor)
    else {
      const probe = new DaemonClient({ descriptor, token: initialized.token, timeoutMs: 500 })
      await probe.call('listProjects', {})
    }
  } catch {
    throw new Error('Refusing to replace a running daemon that did not pass authenticated health validation')
  }
  signal(descriptor.pid, 'SIGTERM')
  await (options.wait ?? waitForProcessExit)(descriptor.pid)
  return true
}

const direct = isDirectExecution(import.meta.url, process.argv[1])
if (direct) {
  runCli(process.argv.slice(2)).then((code) => { process.exitCode = code })
}
