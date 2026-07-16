#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { Writable } from 'node:stream'

import { KnowledgeService } from '../application/knowledge-service.js'
import type { AwaitableKnowledgeBackend } from '../application/backend.js'
import { ensureInstalledDaemon, initializeDaemonCredentials } from '../daemon/lifecycle.js'
import { readDaemonDescriptor } from '../daemon/config.js'
import { defaultNativeBinary, installCurrentUserDaemon, nativeDaemonArguments, uninstallCurrentUserDaemon } from '../daemon/platform.js'
import type { ImportSource } from '../imports/import-service.js'
import type { ProjectGraphSnapshot } from '../imports/snapshot.js'
import { startTraceBenchServer } from '../http/server.js'
import { runStdioServer } from '../mcp/stdio.js'
import { RawLogStore } from '../logs/raw-log-store.js'
import { closeDatabase, openDatabase } from '../storage/database.js'
import { parseArguments, type CliCommand } from './arguments.js'
import { runCommand } from './run-command.js'
import { isDirectExecution } from './direct-execution.js'

interface OutputStream {
  write(value: string | Uint8Array): unknown
}

export interface CliDependencies {
  stdout?: OutputStream
  stderr?: OutputStream
  backend?: AwaitableKnowledgeBackend
}

function printJson(stream: OutputStream, value: unknown): void {
  stream.write(`${JSON.stringify(value, null, 2)}\n`)
}

function project(projectId: string): { projectId: string } {
  return { projectId }
}

async function dispatch(service: AwaitableKnowledgeBackend, command: CliCommand): Promise<unknown> {
  switch (command.kind) {
    case 'project-register': return await service.registerProject(command)
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
    case 'import-preview': return await service.previewImport({ project: project(command.projectId), sources: command.sources as ImportSource[] })
    case 'import-apply': return await service.applyImport({ project: project(command.projectId), previewId: command.previewId, proposalIds: command.proposalIds, operationId: command.operationId })
    case 'import-graph': return await service.importProjectGraph({ project: project(command.projectId), archive: JSON.parse(readFileSync(command.file, 'utf8')) as ProjectGraphSnapshot, operationId: command.operationId })
    case 'export': return await service.exportProjectGraph({ project: project(command.projectId) })
    case 'activity': return await service.listRecentActivity({ project: project(command.projectId), afterSequence: command.afterSequence, limit: command.limit })
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

async function waitForShutdown(close: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    const shutdown = () => { void close().finally(resolve) }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  })
}

export async function runCli(argv: string[], dependencies: CliDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout
  const stderr = dependencies.stderr ?? process.stderr
  try {
    const parsed = parseArguments(argv)
    const databasePath = join(parsed.dataDirectory, 'knowledge.db')
    if (parsed.command.kind === 'daemon') {
      const initialized = initializeDaemonCredentials({ environment: { ...process.env, EKG_DATA_DIR: parsed.dataDirectory } })
      if (parsed.command.action === 'install') {
        printJson(stdout, installCurrentUserDaemon())
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
        printJson(stdout, { running: false, guidance: 'Run `ekg daemon install` or any normal EKG command.' })
        return parsed.command.action === 'doctor' ? 1 : 0
      }
      const running = (() => {
        try { process.kill(descriptor.pid, 0); return true } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'EPERM'
        }
      })()
      if (parsed.command.action === 'stop' && running) process.kill(descriptor.pid, 'SIGTERM')
      printJson(stdout, {
        running: parsed.command.action === 'stop' ? false : running,
        protocolVersion: descriptor.protocolVersion,
        daemonVersion: descriptor.daemonVersion,
        pid: descriptor.pid,
        port: descriptor.port,
        ...(descriptor.browserPort && { webUrl: `http://127.0.0.1:${descriptor.browserPort}` }),
        ...(parsed.command.action === 'doctor' && { dataDirectory: initialized.paths.dataDirectory, tokenPresent: initialized.token.length === 64 }),
      })
      return running || parsed.command.action === 'stop' ? 0 : 1
    }
    if (parsed.command.kind === 'mcp-stdio') {
      await runStdioServer(parsed.embedded ? { databasePath } : { backend: dependencies.backend })
      return 0
    }
    if (!parsed.embedded && parsed.command.kind !== 'serve' && parsed.command.kind !== 'integrity') {
      const service = dependencies.backend ?? (await ensureInstalledDaemon()).backend
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
        return result.exitCode
      }
      const result = await dispatch(service, parsed.command)
      if (parsed.command.kind === 'export' && parsed.command.output) {
        writeFileSync(parsed.command.output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
        printJson(stdout, { output: parsed.command.output })
      } else printJson(stdout, result)
      return 0
    }
    const database = openDatabase(databasePath)
    try {
      if (parsed.command.kind === 'serve') {
        const running = await startTraceBenchServer({
          service: new KnowledgeService(database),
          port: parsed.command.port,
        })
        stdout.write(`http://${running.address.address}:${running.address.port}\n`)
        await waitForShutdown(running.close)
        return 0
      }
      if (parsed.command.kind === 'integrity') {
        const rows = database.pragma('quick_check') as Array<{ quick_check: string }>
        const ok = rows.every((row) => row.quick_check === 'ok')
        printJson(stdout, {
          ok,
          check: 'quick_check',
          results: rows,
          ...(!ok && {
            recovery: 'Create a backup of knowledge.db before recovery. Use `sqlite3 knowledge.db ".recover" > recovered.sql`, restore into a separate data directory, rerun `ekg integrity`, then use `ekg export`.',
          }),
        })
        return ok ? 0 : 1
      }
      if (parsed.command.kind === 'run') {
        const result = await runCommand({
          service: new KnowledgeService(database),
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
        if (result.signal && process.platform !== 'win32') {
          process.kill(process.pid, result.signal)
        }
        return result.exitCode
      }
      const result = await dispatch(new KnowledgeService(database), parsed.command)
      if (parsed.command.kind === 'export' && parsed.command.output) {
        writeFileSync(parsed.command.output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
        printJson(stdout, { output: parsed.command.output })
      } else {
        printJson(stdout, result)
      }
      return 0
    } finally {
      closeDatabase(database)
    }
  } catch (error) {
    const value = error instanceof Error
      ? { error: error.name, message: error.message }
      : { error: 'Error', message: String(error) }
    printJson(stderr, value)
    return 1
  }
}

const direct = isDirectExecution(import.meta.url, process.argv[1])
if (direct) {
  runCli(process.argv.slice(2)).then((code) => { process.exitCode = code })
}
