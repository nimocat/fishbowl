export const MACOS_DAEMON_LABEL = 'io.ekg.daemon'

export interface ProcessCommand { file: string; args: string[] }

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export function launchAgentPlist(options: { executablePath: string; arguments: string[] }): string {
  const programArguments = [options.executablePath, ...options.arguments]
    .map((value) => `    <string>${xml(value)}</string>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${MACOS_DAEMON_LABEL}</string>
  <key>ProgramArguments</key><array>
${programArguments}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict></plist>
`
}

export function macosInstallCommands(plistPath: string, uid: number): ProcessCommand[] {
  return [
    { file: 'launchctl', args: ['bootout', `gui/${uid}`, plistPath] },
    { file: 'launchctl', args: ['bootstrap', `gui/${uid}`, plistPath] },
    { file: 'launchctl', args: ['kickstart', '-k', `gui/${uid}/${MACOS_DAEMON_LABEL}`] },
  ]
}

export function macosUninstallCommands(plistPath: string, uid: number): ProcessCommand[] {
  return [{ file: 'launchctl', args: ['bootout', `gui/${uid}`, plistPath] }]
}
