import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'

import { DaemonClient, createDaemonBackend } from './client.js'
import { ensureDaemonCredentials, readDaemonDescriptor, resolveDaemonPaths } from './config.js'

export function connectInstalledDaemon(options: {
  environment?: Record<string, string | undefined>
  home?: string
  platform?: NodeJS.Platform
  startInstalledService?: () => void | Promise<void>
} = {}) {
  const paths = resolveDaemonPaths({
    platform: options.platform ?? process.platform,
    home: options.home ?? homedir(),
    environment: options.environment ?? process.env,
  })
  const descriptor = readDaemonDescriptor({ paths })
  const token = readFileSync(paths.tokenFile, 'utf8').trim()
  const client = new DaemonClient({ descriptor, token, startInstalledService: options.startInstalledService })
  return { paths, descriptor, client, backend: createDaemonBackend(client) }
}

export function initializeDaemonCredentials(options: {
  environment?: Record<string, string | undefined>
  home?: string
  platform?: NodeJS.Platform
} = {}) {
  const paths = resolveDaemonPaths({
    platform: options.platform ?? process.platform,
    home: options.home ?? homedir(),
    environment: options.environment ?? process.env,
  })
  return { paths, ...ensureDaemonCredentials({ paths }) }
}

export async function ensureInstalledDaemon(options: {
  environment?: Record<string, string | undefined>
  home?: string
  platform?: NodeJS.Platform
  entryPoint?: string
  startupTimeoutMs?: number
} = {}) {
  const initialized = initializeDaemonCredentials(options)
  const connect = async () => {
    const descriptor = readDaemonDescriptor({ paths: initialized.paths })
    const client = new DaemonClient({ descriptor, token: initialized.token, timeoutMs: 250 })
    await client.call('listProjects', {})
    return { paths: initialized.paths, descriptor, client, backend: createDaemonBackend(client) }
  }
  try { return await connect() } catch { /* start once below */ }
  const entryPoint = options.entryPoint ?? process.argv[1]
  if (!entryPoint) throw new Error('EKG daemon is unavailable and the CLI entry point is unknown; run `ekg daemon install`')
  const child = spawn(process.execPath, [entryPoint, 'daemon', 'foreground'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...options.environment, EKG_DATA_DIR: initialized.paths.dataDirectory },
  })
  child.unref()
  const deadline = Date.now() + (options.startupTimeoutMs ?? 2_500)
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    try { return await connect() } catch { /* bounded poll */ }
  }
  throw new Error('EKG daemon did not become ready. Run `ekg daemon doctor`.')
}
