import { describe, expect, it } from 'vitest'

import { launchAgentPlist, macosInstallCommands } from '../../src/daemon/macos-launchd.js'
import { windowsRunCommand, windowsRunRegistrationArgs } from '../../src/daemon/windows-run.js'

describe('current-user daemon registration', () => {
  it('builds a no-admin macOS LaunchAgent with explicit arguments', () => {
    const plist = launchAgentPlist({ nodePath: '/opt/node', entryPoint: '/Users/A B/ekg.js' })
    expect(plist).toContain('<key>RunAtLoad</key>')
    expect(plist).toContain('<key>KeepAlive</key>')
    expect(plist).toContain('/Users/A B/ekg.js')
    expect(macosInstallCommands('/Users/test/Library/LaunchAgents/io.ekg.daemon.plist', 501))
      .toEqual(expect.arrayContaining([expect.objectContaining({ file: 'launchctl', args: ['bootstrap', 'gui/501', expect.any(String)] })]))
  })

  it('registers Windows startup only under HKCU with safe quoting', () => {
    const command = windowsRunCommand('C:\\Program Files\\node.exe', 'C:\\Users\\Eric A\\ekg.js')
    expect(command).toBe('"C:\\Program Files\\node.exe" "C:\\Users\\Eric A\\ekg.js" daemon foreground')
    const args = windowsRunRegistrationArgs(command)
    expect(args.slice(0, 2)).toEqual(['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'])
    expect(args).not.toContain('HKLM')
  })
})
