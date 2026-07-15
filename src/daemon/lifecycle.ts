import { readFileSync } from 'node:fs'
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
