import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const executable = process.platform === 'win32' ? 'ekg-rust-core.exe' : 'ekg-rust-core'
const result = spawnSync('cargo', ['build', '--release', '-p', 'ekg-daemon', '--bin', 'ekg-rust-core'], {
  stdio: 'inherit',
  shell: false,
})
if (result.status !== 0) process.exit(result.status ?? 1)

const destinationDirectory = join('dist', 'native')
mkdirSync(destinationDirectory, { recursive: true, mode: 0o755 })
const destination = join(destinationDirectory, executable)
copyFileSync(join('target', 'release', executable), destination)
if (process.platform !== 'win32') chmodSync(destination, 0o755)
