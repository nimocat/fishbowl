import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function isDirectExecution(importMetaUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) return false
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(resolve(argvPath))
  } catch {
    return false
  }
}
