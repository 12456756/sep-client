import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

const directory = process.argv[2] || 'dist'
const files = (await readdir(directory, { withFileTypes: true }))
  .filter(entry => entry.isFile() && /\.(dmg|exe)$/i.test(entry.name))
  .map(entry => entry.name)
  .sort()
const lines = []
for (const name of files) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => createReadStream(join(directory, name)).on('data', chunk => hash.update(chunk)).on('end', resolve).on('error', reject))
  lines.push(`${hash.digest('hex')}  ${basename(name)}`)
}
await writeFile(join(directory, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`)
console.log(`checksums: ${lines.length} artifacts`)
