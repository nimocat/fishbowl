import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Readable, Writable } from 'node:stream'

import type { AwaitableKnowledgeBackend } from '../application/backend.js'
import { ensureInstalledDaemon } from '../daemon/lifecycle.js'
import { DaemonTimingLedger } from '../daemon/client.js'
import { createMcpServer } from './server.js'
import { isDirectExecution } from '../cli/direct-execution.js'

export interface StdioServerOptions {
  backend?: AwaitableKnowledgeBackend
  dataDirectory?: string
  input?: Readable
  output?: Writable
}

export interface StdioServerHandle {
  close(): Promise<void>
}

export async function runStdioServer(
  options: StdioServerOptions = {},
): Promise<StdioServerHandle> {
  const daemonTimings = new DaemonTimingLedger()
  const service = options.backend ?? (await ensureInstalledDaemon({
    environment: options.dataDirectory ? { ...process.env, EKG_DATA_DIR: options.dataDirectory } : process.env,
    observeTiming: (sample) => daemonTimings.record(sample),
  })).backend
  const server = createMcpServer(service, {
    daemonTimings: options.backend ? undefined : daemonTimings,
  })
  const transport = new StdioServerTransport(options.input, options.output)
  let closed = false

  try {
    await server.connect(transport)
  } catch (error) {
    throw error
  }

  return {
    async close() {
      if (closed) return
      closed = true
      await server.close()
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
