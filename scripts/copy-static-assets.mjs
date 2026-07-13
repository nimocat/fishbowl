import { copyFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const source = resolve(process.argv[2] ?? 'src/web')
const destination = resolve(process.argv[3] ?? 'dist/web')
const assets = ['index.html', 'styles.css', 'app.js']

mkdirSync(destination, { recursive: true })
for (const asset of assets) {
  copyFileSync(resolve(source, asset), resolve(destination, asset))
}
