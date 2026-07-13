import { appendFileSync } from 'node:fs'

const options = JSON.parse(process.argv[2])
if (options.marker) appendFileSync(options.marker, 'spawned')
process.stdout.write(Buffer.from(options.stdout ?? '', 'base64'))
process.stderr.write(Buffer.from(options.stderr ?? '', 'base64'))
process.stdout.write(`${JSON.stringify(process.argv.slice(3))}\n`)
process.exitCode = options.exitCode ?? 0
