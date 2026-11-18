import { createReadStream, realpathSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import yaml from 'js-yaml'
import { parseManifest, readBounded, validateManifestSet } from './verify-update-manifest.mjs'

const NAME = 'latest-mac.yml'

export async function mergeMacUpdateManifests(arm64File, x64File, output) {
  const manifests = []
  for (const [arch, source] of [['arm64', arm64File], ['x64', x64File]]) {
    const manifest = parseManifest(await readBounded(createReadStream(source)), NAME)
    for (const file of manifest.files) {
      if (file.url !== basename(file.url)) throw new Error('Mac artifacts must be in the source directory root')
      if (!['zip', 'dmg'].some(ext => file.url === `SEP-Client-${manifest.version}-mac-${arch}.${ext}`)) {
        throw new Error(`Expected only macOS ${arch} artifacts in its manifest`)
      }
    }
    manifests.push({ name: NAME, manifest })
  }
  validateManifestSet(manifests)
  const [arm64, x64] = manifests.map(entry => entry.manifest)
  for (const field of ['releaseNotes', 'releaseName']) {
    if (!isDeepStrictEqual(arm64[field], x64[field])) throw new Error(`Mac ${field} must match across architectures`)
  }
  // Keep x64 legacy fields together; files contains the full list for modern clients.
  const merged = { ...x64, files: [...x64.files, ...arm64.files] }
  const text = yaml.dump(merged, { lineWidth: -1, noRefs: true, sortKeys: false })
  parseManifest(text, NAME)
  await writeFile(output, text, 'utf8')
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2)
    if (args.length !== 3) throw new Error('usage: node scripts/merge-mac-update-manifests.mjs <arm64-manifest> <x64-manifest> <output-manifest>')
    await mergeMacUpdateManifests(...args)
    console.log('Merged macOS arm64 and x64 update manifests')
  } catch (error) {
    console.error(`Mac manifest merge failed: ${error.message}`)
    process.exitCode = 1
  }
}
