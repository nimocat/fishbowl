#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'

import { KnowledgeService } from '../application/knowledge-service.js'
import type { KnowledgeServiceContract } from '../application/contracts.js'
import type { ImportSource } from '../imports/import-service.js'
import type { ProjectGraphSnapshot } from '../imports/snapshot.js'
import { startTraceBenchServer } from '../http/server.js'
import { runStdioServer } from '../mcp/stdio.js'
import { RawLogStore } from '../logs/raw-log-store.js'
import { closeDatabase, openDatabase } from '../storage/database.js'
import { parseArguments, type CliCommand } from './arguments.js'
import { runCommand } from './run-command.js'

interface OutputStream {
  write(value: string | Uint8Array): unknown
}

export interface CliDependencies {
  stdout?: OutputStream
  stderr?: OutputStream
}

function printJson(stream: OutputStream, value: unknown): void {
  stream.write(`${JSON.stringify(value, null, 2)}\n`)
}

function project(projectId: string): { projectId: string } {
  return { projectId }
}

function dispatch(service: KnowledgeServiceContract, command: CliCommand): unknown {
  switch (command.kind) {
    case 'project-register': return service.registerProject(command)
    case 'project-list': return service.listProjects()
    case 'project-resolve': return service.resolveProject({ projectId: command.projectId, projectRoot: command.projectRoot })
    case 'project-update': return service.updateProject({ project: project(command.projectId), name: command.name, description: command.description, addAlias: command.addAlias })
    case 'query': return service.queryKnowledge({ ...command.filters, project: project(command.projectId), text: command.text })
    case 'preflight': return service.preflight({ project: project(command.projectId), taskDescription: command.taskDescription, command: command.command, changedFiles: command.changedFiles })
    case 'case-start': return service.recordProblem({ project: project(command.projectId), caseTitle: command.caseTitle, data: command.data as never, operationId: command.operationId })
    case 'case-attempt': return service.recordAttempt({ project: project(command.projectId), caseId: command.caseId, problemId: command.problemId, previousAttemptId: command.previousAttemptId, data: command.data as never, operationId: command.operationId })
    case 'case-root-cause': return service.recordRootCause({ project: project(command.projectId), caseId: command.caseId, problemId: command.problemId, failedAttemptIds: command.failedAttemptIds, status: command.status, humanConfirmed: command.humanConfirmed, data: command.data as never, operationId: command.operationId })
    case 'case-solution': return service.recordSolution({ project: project(command.projectId), caseId: command.caseId, rootCauseId: command.rootCauseId, data: command.data as never, operationId: command.operationId })
    case 'case-verify': return service.recordVerification({ project: project(command.projectId), caseId: command.caseId, solutionId: command.solutionId, data: command.data as never, operationId: command.operationId })
    case 'case-close': return service.closeCase({ project: project(command.projectId), caseId: command.caseId, operationId: command.operationId })
    case 'case-regress': return service.markRegression({ project: project(command.projectId), caseId: command.caseId, solutionId: command.solutionId, fingerprint: command.fingerprint, observedContext: command.observedContext, operationId: command.operationId })
    case 'import-preview': return service.previewImport({ project: project(command.projectId), sources: command.sources as ImportSource[] })
    case 'import-apply': return service.applyImport({ project: project(command.projectId), previewId: command.previewId, proposalIds: command.proposalIds, operationId: command.operationId })
    case 'import-graph': return service.importProjectGraph({ project: project(command.projectId), archive: JSON.parse(readFileSync(command.file, 'utf8')) as ProjectGraphSnapshot, operationId: command.operationId })
    case 'export': return service.exportProjectGraph({ project: project(command.projectId) })
    case 'activity': return service.listRecentActivity({ project: project(command.projectId), afterSequence: command.afterSequence, limit: command.limit })
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
    if (parsed.command.kind === 'mcp-stdio') {
      await runStdioServer({ databasePath })
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
      const result = dispatch(new KnowledgeService(database), parsed.command)
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

const direct = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (direct) {
  runCli(process.argv.slice(2)).then((code) => { process.exitCode = code })
}
