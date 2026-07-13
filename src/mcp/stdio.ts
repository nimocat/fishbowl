import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Readable, Writable } from 'node:stream'

import { KnowledgeService } from '../application/knowledge-service.js'
import { closeDatabase, openDatabase } from '../storage/database.js'
import { createMcpServer } from './server.js'

export interface StdioServerOptions {
  databasePath?: string
  input?: Readable
  output?: Writable
}

export interface StdioServerHandle {
  close(): Promise<void>
}

function defaultDatabasePath(): string {
  const dataDirectory = process.env.EKG_DATA_DIR ?? join(homedir(), '.engineering-knowledge-graph', 'data')
  return join(dataDirectory, 'knowledge.db')
}

export async function runStdioServer(
  options: StdioServerOptions = {},
): Promise<StdioServerHandle> {
  const database = openDatabase(options.databasePath ?? defaultDatabasePath())
  const server = createMcpServer(new KnowledgeService(database))
  const transport = new StdioServerTransport(options.input, options.output)
  let closed = false

  try {
    await server.connect(transport)
  } catch (error) {
    closeDatabase(database)
    throw error
  }

  return {
    async close() {
      if (closed) return
      closed = true
      await server.close()
      closeDatabase(database)
    },
  }
}

const isDirectExecution =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectExecution) {
  runStdioServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Failed to start MCP stdio server: ${message}\n`)
    process.exitCode = 1
  })
}
