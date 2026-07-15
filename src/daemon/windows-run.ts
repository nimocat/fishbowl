export const WINDOWS_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
export const WINDOWS_RUN_VALUE = 'EngineeringKnowledgeGraph'

function quote(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`
}

export function windowsRunCommand(nodePath: string, entryPoint: string): string {
  return `${quote(nodePath)} ${quote(entryPoint)} daemon foreground`
}

export function windowsRunRegistrationArgs(command: string): string[] {
  return ['add', WINDOWS_RUN_KEY, '/v', WINDOWS_RUN_VALUE, '/t', 'REG_SZ', '/d', command, '/f']
}

export function windowsRunRemovalArgs(): string[] {
  return ['delete', WINDOWS_RUN_KEY, '/v', WINDOWS_RUN_VALUE, '/f']
}
