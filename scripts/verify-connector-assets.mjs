import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const targets = ['win32-x64', 'darwin-x64', 'darwin-arm64']
const ids = ['dingtalk', 'feishu', 'wecom']

export async function connectorArtifactPlan(source, { required = false } = {}) {
  const root = join(source, 'connector-assets')
  try {
    const metadata = await lstat(root)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Unsafe connector artifact directory')
  } catch (error) {
    if (!required && error.code === 'ENOENT') return []
    throw error
  }
  const artifacts = []
  for (const target of targets) {
    const manifestPath = join(root, `${target}.json`)
    const metadata = await lstat(manifestPath)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 65536) throw new Error('Unsafe connector manifest')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.components) || manifest.components.length !== 3) throw new Error('Invalid connector manifest')
    for (const id of ids) {
      const component = manifest.components.find(item => item.id === id)
      if (!component || `${component.platform}-${component.arch}` !== target || !/^\d+\.\d+\.\d+$/.test(component.version) || !/^[a-f0-9]{64}$/.test(component.sha256) || !Number.isSafeInteger(component.bytes) || component.bytes < 1 || component.bytes > 128 * 1024 * 1024) throw new Error('Invalid connector component')
      const name = `${id}-${component.version}-${target}-${component.sha256}.zip`
      if (component.archive !== name) throw new Error('Invalid connector archive path')
      const file = join(root, name)
      const info = await lstat(file)
      if (!info.isFile() || info.isSymbolicLink() || info.size !== component.bytes) throw new Error('Connector archive is missing or unsafe')
      const bytes = await readFile(file)
      if (createHash('sha256').update(bytes).digest('hex') !== component.sha256) throw new Error('Connector archive hash mismatch')
      artifacts.push({ name, size: component.bytes, sha256: component.sha256 })
    }
  }
  return artifacts
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const artifacts = await connectorArtifactPlan(process.argv[2], { required: true })
    console.log(`Verified ${artifacts.length} connector components for Windows x64 and macOS x64/arm64`)
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
