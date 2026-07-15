import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Readable, Writable } from 'node:stream'

import type { AwaitableKnowledgeBackend } from '../application/backend.js'
import { KnowledgeService } from '../application/knowledge-service.js'
import { ensureInstalledDaemon } from '../daemon/lifecycle.js'
import { closeDatabase, openDatabase } from '../storage/database.js'
import { createMcpServer } from './server.js'
import { isDirectExecution } from '../cli/direct-execution.js'

export interface StdioServerOptions {
  backend?: AwaitableKnowledgeBackend
  /** Explicit embedded test/recovery mode. Normal startup uses the daemon. */
  databasePath?: string
  input?: Readable
  output?: Writable
}

export interface StdioServerHandle {
  close(): Promise<void>
}

export async function runStdioServer(
  options: StdioServerOptions = {},
): Promise<StdioServerHandle> {
  const database = options.databasePath ? openDatabase(options.databasePath) : undefined
  const service = options.backend ?? (database ? new KnowledgeService(database) : (await ensureInstalledDaemon()).backend)
  const server = createMcpServer(service)
  const transport = new StdioServerTransport(options.input, options.output)
  let closed = false

  try {
    await server.connect(transport)
  } catch (error) {
    if (database) closeDatabase(database)
    throw error
  }

  return {
    async close() {
      if (closed) return
      closed = true
      await server.close()
      if (database) closeDatabase(database)
    },
  }
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  runStdioServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Failed to start MCP stdio server: ${message}\n`)
    process.exitCode = 1
  })
}
