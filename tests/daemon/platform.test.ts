import { describe, expect, it } from 'vitest'

import { launchAgentPlist, macosInstallCommands } from '../../src/daemon/macos-launchd.js'
import { windowsRunCommand, windowsRunRegistrationArgs } from '../../src/daemon/windows-run.js'
import { nativeDaemonArguments } from '../../src/daemon/platform.js'
import type { DaemonPaths } from '../../src/daemon/config.js'

describe('current-user daemon registration', () => {
  it('passes the persisted user port to every native daemon launch', () => {
    const paths = {
      databasePath: '/data/knowledge.db',
      tokenFile: '/data/daemon.token',
      descriptorFile: '/data/daemon.json',
      pidFile: '/data/daemon.pid',
    } as DaemonPaths

    expect(nativeDaemonArguments(paths, 56_341)).toEqual(expect.arrayContaining(['--port', '56341']))
    expect(nativeDaemonArguments(paths, 56_341)).not.toContain('0')
  })

  it('builds a no-admin macOS LaunchAgent with explicit arguments', () => {
    const plist = launchAgentPlist({
      executablePath: '/Users/A B/fishbowl-rust-core',
      arguments: ['daemon', '--database', '/Users/A B/knowledge.db'],
    })
    expect(plist).toContain('<key>RunAtLoad</key>')
    expect(plist).toContain('<key>KeepAlive</key>')
    expect(plist).toContain('/Users/A B/fishbowl-rust-core')
    expect(plist).toContain('--database')
    expect(plist).not.toContain('node')
    expect(macosInstallCommands('/Users/test/Library/LaunchAgents/io.fishbowl.daemon.plist', 501))
      .toEqual(expect.arrayContaining([expect.objectContaining({ file: 'launchctl', args: ['bootstrap', 'gui/501', expect.any(String)] })]))
  })

  it('registers Windows startup only under HKCU with safe quoting', () => {
    const command = windowsRunCommand(
      'C:\\Users\\Eric A\\fishbowl-rust-core.exe',
      ['daemon', '--database', 'C:\\Users\\Eric A\\knowledge.db'],
    )
    expect(command).toBe('"C:\\Users\\Eric A\\fishbowl-rust-core.exe" "daemon" "--database" "C:\\Users\\Eric A\\knowledge.db"')
    const args = windowsRunRegistrationArgs(command)
    expect(args.slice(0, 2)).toEqual(['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'])
    expect(args).not.toContain('HKLM')
  })
})
