import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

async function sourceFingerprint(paths) {
  return Promise.all(paths.map(async path => {
    try {
      const stat = await lstat(path)
      return [path, stat.size, stat.mtimeMs, stat.ctimeMs]
    } catch (error) {
      if (error.code === 'ENOENT') return [path, null]
      throw error
    }
  }))
}

async function outputFingerprint(directory, files) {
  return Promise.all(files.map(async file => {
    const path = join(directory, file)
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error('Invalid development asset: ' + file)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    return [file, stat.mode, hash.digest('hex')]
  }))
}

// Only CLI development entry points use this cache; packaging always verifies archives.
export async function prepareDevelopmentAssets({ directory, sources, outputs, prepare, platform = process.platform, arch = process.arch }) {
  const cachePath = join(directory, '.sep-dev-assets.json')
  const identity = { schemaVersion: 1, platform, arch, sources: await sourceFingerprint(sources) }
  try {
    const cached = JSON.parse(await readFile(cachePath, 'utf8'))
    if (JSON.stringify(cached.identity) === JSON.stringify(identity)
      && JSON.stringify(cached.outputs) === JSON.stringify(await outputFingerprint(directory, outputs))) return
  } catch { /* Missing, outdated or damaged assets are prepared again. */ }
  await prepare()
  await writeFile(cachePath, JSON.stringify({
    identity: { ...identity, sources: await sourceFingerprint(sources) },
    outputs: await outputFingerprint(directory, outputs),
  }))
}
