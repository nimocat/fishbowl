import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'

import { DaemonClient, createDaemonBackend, type DaemonTimingSample } from './client.js'
import {
  ensureDaemonCredentials,
  ensureDaemonPort,
  migrateLegacyDataDirectory,
  readDaemonDescriptor,
  resolveDaemonPaths,
} from './config.js'
import { defaultNativeBinary, nativeDaemonArguments } from './platform.js'

export function connectInstalledDaemon(options: {
  environment?: Record<string, string | undefined>
  home?: string
  platform?: NodeJS.Platform
  startInstalledService?: () => void | Promise<void>
  observeTiming?: (sample: DaemonTimingSample) => void
} = {}) {
  const paths = resolveDaemonPaths({
    platform: options.platform ?? process.platform,
    home: options.home ?? homedir(),
    environment: options.environment ?? process.env,
  })
  const descriptor = readDaemonDescriptor({ paths })
  const token = readFileSync(paths.tokenFile, 'utf8').trim()
  const client = new DaemonClient({ descriptor, token, startInstalledService: options.startInstalledService, observeTiming: options.observeTiming })
  return { paths, descriptor, client, backend: createDaemonBackend(client) }
}

export function initializeDaemonCredentials(options: {
  environment?: Record<string, string | undefined>
  home?: string
  platform?: NodeJS.Platform
} = {}) {
  const resolveOptions = {
    platform: options.platform ?? process.platform,
    home: options.home ?? homedir(),
    environment: options.environment ?? process.env,
  }
  migrateLegacyDataDirectory(resolveOptions)
  const paths = resolveDaemonPaths(resolveOptions)
  const credentials = ensureDaemonCredentials({ paths })
  return { paths, ...credentials, port: ensureDaemonPort({ paths }) }
}

export async function ensureInstalledDaemon(options: {
  environment?: Record<string, string | undefined>
  home?: string
  platform?: NodeJS.Platform
  nativeBinary?: string
  detached?: boolean
  startupTimeoutMs?: number
  observeTiming?: (sample: DaemonTimingSample) => void
} = {}) {
  const initialized = initializeDaemonCredentials(options)
  const connect = async () => {
    const descriptor = readDaemonDescriptor({ paths: initialized.paths })
    const probe = new DaemonClient({ descriptor, token: initialized.token, timeoutMs: 250, observeTiming: options.observeTiming })
    await probe.call('listProjects', {})
    const client = new DaemonClient({ descriptor, token: initialized.token, observeTiming: options.observeTiming })
    return { paths: initialized.paths, descriptor, client, backend: createDaemonBackend(client) }
  }
  try { return await connect() } catch { /* start once below */ }
  const nativeBinary = options.nativeBinary ?? defaultNativeBinary(options.platform ?? process.platform)
  const detached = options.detached ?? true
  const child = spawn(nativeBinary, nativeDaemonArguments(initialized.paths, initialized.port), {
    detached,
    stdio: 'ignore',
  })
  if (detached) child.unref()
  const deadline = Date.now() + (options.startupTimeoutMs ?? 2_500)
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    try { return await connect() } catch { /* bounded poll */ }
  }
  throw new Error(
    `Fishbowl daemon did not become ready on fixed port ${initialized.port}. ` +
    `The port is stored in ${initialized.paths.portFile}; run \`fishbowl daemon doctor\`. ` +
    'If another process owns the port, stop it or replace daemon.port with an unused port from 49152 through 65535, then retry.',
  )
}
