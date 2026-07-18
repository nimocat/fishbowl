import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveDaemonPaths, type DaemonPaths } from './config.js'
import { launchAgentPlist, macosInstallCommands, macosUninstallCommands } from './macos-launchd.js'
import {
  legacyWindowsRunRemovalArgs,
  windowsRunCommand,
  windowsRunRegistrationArgs,
  windowsRunRemovalArgs,
} from './windows-run.js'

export interface PlatformRegistrationResult {
  platform: 'darwin' | 'win32'
  location: string
  dataPreserved: true
}

export function installCurrentUserDaemon(options: {
  platform?: NodeJS.Platform
  home?: string
  nativeBinary?: string
  paths?: DaemonPaths
  uid?: number
} = {}): PlatformRegistrationResult {
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const nativeBinary = options.nativeBinary ?? defaultNativeBinary(platform)
  const paths = options.paths ?? resolveDaemonPaths({ platform, home, environment: process.env })
  const daemonArguments = nativeDaemonArguments(paths)
  if (platform === 'darwin') {
    const directory = join(home, 'Library', 'LaunchAgents')
    const location = join(directory, 'io.fishbowl.daemon.plist')
    retireLegacyMacOSDaemon(directory, options.uid ?? process.getuid?.() ?? 0)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeFileSync(location, launchAgentPlist({ executablePath: nativeBinary, arguments: daemonArguments }), { mode: 0o600 })
    for (const [index, command] of macosInstallCommands(location, options.uid ?? process.getuid?.() ?? 0).entries()) {
      try { execFileSync(command.file, command.args, { stdio: 'ignore' }) } catch (error) {
        if (index !== 0) throw error // An absent prior service is expected on first install.
      }
    }
    return { platform: 'darwin', location, dataPreserved: true }
  }
  if (platform === 'win32') {
    try { execFileSync('reg.exe', legacyWindowsRunRemovalArgs(), { stdio: 'ignore' }) } catch { /* old registration absent */ }
    const command = windowsRunCommand(nativeBinary, daemonArguments)
    execFileSync('reg.exe', windowsRunRegistrationArgs(command), { stdio: 'ignore' })
    return { platform: 'win32', location: WINDOWS_LOCATION, dataPreserved: true }
  }
  throw new Error('Automatic daemon installation currently supports macOS and Windows')
}

export function uninstallCurrentUserDaemon(options: {
  platform?: NodeJS.Platform
  home?: string
  uid?: number
} = {}): PlatformRegistrationResult {
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  if (platform === 'darwin') {
    const location = join(home, 'Library', 'LaunchAgents', 'io.fishbowl.daemon.plist')
    for (const command of macosUninstallCommands(location, options.uid ?? process.getuid?.() ?? 0)) {
      try { execFileSync(command.file, command.args, { stdio: 'ignore' }) } catch { /* already stopped */ }
    }
    rmSync(location, { force: true })
    return { platform: 'darwin', location, dataPreserved: true }
  }
  if (platform === 'win32') {
    try { execFileSync('reg.exe', windowsRunRemovalArgs(), { stdio: 'ignore' }) } catch { /* already removed */ }
    return { platform: 'win32', location: WINDOWS_LOCATION, dataPreserved: true }
  }
  throw new Error('Automatic daemon removal currently supports macOS and Windows')
}

const WINDOWS_LOCATION = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

function retireLegacyMacOSDaemon(directory: string, uid: number): void {
  const legacyLocation = join(directory, 'io.ekg.daemon.plist')
  for (const command of macosUninstallCommands(legacyLocation, uid)) {
    try { execFileSync(command.file, command.args, { stdio: 'ignore' }) } catch { /* old service absent */ }
  }
  rmSync(legacyLocation, { force: true })
}

export function nativeDaemonArguments(paths: DaemonPaths): string[] {
  return [
    'daemon',
    '--database', paths.databasePath,
    '--token-file', paths.tokenFile,
    '--descriptor', paths.descriptorFile,
    '--pid-file', paths.pidFile,
    '--port', '0',
  ]
}

export function defaultNativeBinary(platform: NodeJS.Platform = process.platform): string {
  const executable = platform === 'win32' ? 'fishbowl-rust-core.exe' : 'fishbowl-rust-core'
  const packaged = join(dirname(fileURLToPath(import.meta.url)), '..', 'native', executable)
  if (existsSync(packaged)) return packaged
  // Source-level tests execute from src/, while release adapters execute from dist/.
  // Both resolve the same packaged native artifact; neither falls back to a TS core.
  return join(process.cwd(), 'dist', 'native', executable)
}
