import { createHash } from 'node:crypto'
import { constants, realpathSync } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import yaml from 'js-yaml'
import { UPDATE_FEEDS } from './generate-builder-config.mjs'
import { MANIFEST_NAMES, MAX_MANIFEST_BYTES, parseManifest, validateArtifactPath, validateManifestSet, verifyUpdateDirectory } from './verify-update-manifest.mjs'

const MODE = 'unsigned-download-update'

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

function contained(parent, child) {
  const difference = relative(parent, child)
  return difference === '' || (!isAbsolute(difference) && difference !== '..' && !difference.startsWith(`..${sep}`))
}

function artifactNames(version) {
  const prefix = `SEP-Client-${version}`
  return [
    `${prefix}-win-x64.exe`, `${prefix}-win-x64.exe.blockmap`,
    ...['arm64', 'x64'].flatMap(arch => ['dmg', 'zip'].flatMap(extension => [
      `${prefix}-mac-${arch}.${extension}`, `${prefix}-mac-${arch}.${extension}.blockmap`,
    ])),
  ]
}

async function outputDirectory(source, output) {
  requireValue(typeof output === 'string' && output.length > 0, 'output directory is required')
  const requested = resolve(output)
  const parent = await realpath(dirname(requested))
  const destination = join(parent, basename(requested))
  requireValue(!contained(source, destination) && !contained(destination, source), 'source and output directories must be disjoint')
  try {
    await lstat(destination)
    throw new Error('output already exists')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return destination
}

function versionedPath(version, value) {
  const path = validateArtifactPath(value)
  requireValue(path === basename(path), 'builder manifests must reference artifacts in the source directory root')
  return `${version}/${path}`
}

function rewriteManifest(manifest, name) {
  const rewritten = structuredClone(manifest)
  rewritten.files = rewritten.files.map(file => ({ ...file, url: versionedPath(manifest.version, file.url) }))
  if (typeof rewritten.path === 'string') rewritten.path = versionedPath(manifest.version, rewritten.path)
  const text = yaml.dump(rewritten, { lineWidth: -1, noRefs: true, sortKeys: false })
  return { name, manifest: parseManifest(text, name), text }
}

async function readManifest(root, name) {
  const handle = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat()
    requireValue(metadata.isFile() && metadata.size > 0 && metadata.size <= MAX_MANIFEST_BYTES, `${name}: invalid manifest file`)
    return handle.readFile()
  } finally {
    await handle.close()
  }
}

async function hashArtifact(path, expectedSize) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat()
    requireValue(metadata.isFile() && metadata.size === expectedSize, 'artifact changed while preparing upload plan')
    const digest = createHash('sha256')
    let size = 0
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length
      digest.update(chunk)
    }
    requireValue(size === expectedSize, 'artifact changed while preparing upload plan')
    return digest.digest('hex')
  } finally {
    await handle.close()
  }
}

async function artifactPlan(source, version, feed) {
  const required = artifactNames(version)
  const entries = new Map((await readdir(source, { withFileTypes: true })).map(entry => [entry.name, entry]))
  const artifacts = []
  for (const name of required.sort((left, right) => left.localeCompare(right, 'en'))) {
    requireValue(entries.get(name)?.isFile(), `required local package artifact is missing or unsafe: ${name}`)
    const metadata = await stat(join(source, name))
    requireValue(metadata.size > 0, `required local package artifact is empty: ${name}`)
    const destination = `${version}/${name}`
    const sha256 = await hashArtifact(join(source, name), metadata.size)
    artifacts.push({ name, size: metadata.size, sha256, destination, url: new URL(destination, feed).href })
  }
  return artifacts
}

export async function prepareDownloadUpdate({ source, output, channel }) {
  requireValue(channel === 'beta' || channel === 'stable', 'channel must be beta or stable')
  requireValue(typeof source === 'string' && source.length > 0, 'source directory is required')
  const root = await realpath(resolve(source))
  requireValue((await stat(root)).isDirectory(), 'source must be a directory')
  const destination = await outputDirectory(root, output)

  const originalBytes = new Map()
  const parsed = []
  for (const name of MANIFEST_NAMES) {
    const bytes = await readManifest(root, name)
    originalBytes.set(name, bytes)
    parsed.push({ name, manifest: parseManifest(bytes, name) })
  }
  validateManifestSet(parsed, { requireAllPlatforms: true })
  await verifyUpdateDirectory(root, { requireAllPlatforms: true })
  for (const name of MANIFEST_NAMES) {
    requireValue((await readManifest(root, name)).equals(originalBytes.get(name)), 'source manifests changed during verification')
  }

  const version = parsed[0].manifest.version
  const rewritten = parsed.map(({ name, manifest }) => rewriteManifest(manifest, name))
  validateManifestSet(rewritten, { requireAllPlatforms: true })
  const feed = UPDATE_FEEDS[channel]
  const artifacts = await artifactPlan(root, version, feed)
  const plan = {
    schemaVersion: 1,
    mode: MODE,
    releaseApproved: false,
    signatureVerified: false,
    channel,
    version,
    feed,
    artifacts,
    downloads: {
      macArm64: new URL(`${version}/SEP-Client-${version}-mac-arm64.dmg`, feed).href,
      macX64: new URL(`${version}/SEP-Client-${version}-mac-x64.dmg`, feed).href,
      windowsX64: new URL(`${version}/SEP-Client-${version}-win-x64.exe`, feed).href,
    },
    publishLast: [...MANIFEST_NAMES],
    notice: 'Code signing, notarization, remote upload, installation, and release approval were not verified.',
  }

  await mkdir(destination)
  try {
    for (const item of rewritten) await writeFile(join(destination, item.name), item.text, { encoding: 'utf8', flag: 'wx' })
    await writeFile(join(destination, 'upload-plan.json'), `${JSON.stringify(plan, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    await rm(destination, { recursive: true, force: true })
    throw error
  }
  return { output: destination, version, channel, plan }
}

export function parseArguments(args) {
  const usage = 'usage: node scripts/prepare-download-update.mjs <source-dir> <beta|stable> <output-dir>'
  requireValue(args.length === 3 && args.every(value => typeof value === 'string' && value.length > 0 && !value.startsWith('--')), usage)
  const [source, channel, output] = args
  requireValue(channel === 'beta' || channel === 'stable', usage)
  return { source, channel, output }
}

export async function main(args = process.argv.slice(2)) {
  const result = await prepareDownloadUpdate(parseArguments(args))
  console.log(`prepared ${result.channel} download-update manifests for ${result.version}`)
  console.log(`upload ${result.plan.artifacts.length} artifacts to their version directory, then publish latest.yml and latest-mac.yml last`)
  console.log('releaseApproved=false; signatureVerified=false; no files were uploaded')
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main()
  } catch (error) {
    console.error(`download-update preparation failed: ${error.message}`)
    process.exitCode = 1
  }
}
