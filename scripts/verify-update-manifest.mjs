import { createHash } from 'node:crypto'
import { constants, realpathSync } from 'node:fs'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import yaml from 'js-yaml'

export const MANIFEST_NAMES = Object.freeze(['latest.yml', 'latest-mac.yml'])
export const MAX_MANIFEST_BYTES = 1024 * 1024
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

export function validateManifestName(name) {
  requireValue(MANIFEST_NAMES.includes(name), 'manifest must be latest.yml or latest-mac.yml')
  return name
}

// Only literal relative paths are accepted: URL decoding must never change their meaning.
export function validateArtifactPath(value) {
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= 1024, 'file path must be a nonempty relative path')
  requireValue(!isAbsolute(value) && !value.includes('\\') && !value.includes(':') && !value.includes('%'), 'unsafe file path (expected a literal relative path)')
  const parts = value.split('/')
  requireValue(parts.every(part => /^[A-Za-z0-9._+-]+$/.test(part) && part !== '.' && part !== '..'), 'unsafe file path (expected a literal relative path)')
  return value
}

function validateHash(value, label) {
  requireValue(typeof value === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(value), `${label} must be a canonical SHA512 base64 digest`)
  const digest = Buffer.from(value, 'base64')
  requireValue(digest.length === 64 && digest.toString('base64') === value, `${label} must be a canonical SHA512 base64 digest`)
}

function validateSize(value, label) {
  requireValue(Number.isSafeInteger(value) && value > 0, `${label} must be a positive safe integer`)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function parseManifest(input, manifestName) {
  validateManifestName(manifestName)
  requireValue(typeof input === 'string' || Buffer.isBuffer(input) || input instanceof Uint8Array, 'manifest must be UTF-8 text')
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input
  requireValue(bytes.length > 0 && bytes.length <= MAX_MANIFEST_BYTES, `manifest size must be between 1 and ${MAX_MANIFEST_BYTES} bytes`)
  let manifest
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    manifest = yaml.load(text, {
      schema: yaml.CORE_SCHEMA,
      maxDepth: 40,
      onWarning(warning) { throw warning },
      // Builder manifests need no anchors. Reject them before accepting any shared/cyclic graph.
      listener(event, state) {
        if (event === 'close' && state.anchor !== null) throw new Error('YAML anchors and aliases are not allowed')
      },
    })
  } catch (error) {
    // Do not echo arbitrary YAML (which might contain credentials) into publishing logs.
    const location = error.mark ? ` at line ${error.mark.line + 1}` : ''
    throw new Error(`${manifestName}: invalid YAML/UTF-8${location}`, { cause: error })
  }
  requireValue(isRecord(manifest), `${manifestName}: manifest must be a mapping`)
  if (Object.hasOwn(manifest, 'packages')) {
    requireValue(isRecord(manifest.packages) && Object.keys(manifest.packages).length === 0, `${manifestName}: packages must be an empty mapping; web installers are not supported`)
  }
  const match = typeof manifest.version === 'string' && VERSION.exec(manifest.version)
  requireValue(match && (!match[4] || match[4].split('.').every(id => !/^\d+$/.test(id) || id === '0' || !id.startsWith('0'))), `${manifestName}: version must be a valid SemVer string`)
  requireValue(Array.isArray(manifest.files) && manifest.files.length > 0, `${manifestName}: files must be a nonempty array`)
  const seen = new Set()
  const platformFiles = new Set()
  for (const file of manifest.files) {
    requireValue(isRecord(file), `${manifestName}: each files entry must be a mapping`)
    validateArtifactPath(file.url)
    requireValue(!seen.has(file.url), `${manifestName}: duplicate file path: ${file.url}`)
    seen.add(file.url)
    validateSize(file.size, `${file.url}: size`)
    validateHash(file.sha512, `${file.url}: sha512`)
    const artifact = /^SEP-Client-(.+)-(mac|win)-(arm64|x64)\.(zip|dmg|exe)$/.exec(basename(file.url))
    requireValue(artifact && artifact[1] === manifest.version, `${file.url}: artifact name must match SEP-Client-${manifest.version}-\${os}-\${arch}.\${ext}`)
    const [, , os, arch, ext] = artifact
    if (manifestName === 'latest-mac.yml') {
      requireValue(os === 'mac' && (ext === 'zip' || ext === 'dmg'), `${file.url}: mac manifest requires mac ZIP/DMG artifacts`)
      if (ext === 'zip') platformFiles.add(`mac-${arch}`)
    } else {
      requireValue(os === 'win' && arch === 'x64' && ext === 'exe', `${file.url}: Windows manifest requires win-x64 NSIS EXE artifacts`)
      platformFiles.add('win-x64')
    }
  }
  requireValue(platformFiles.size > 0, `${manifestName}: must contain ${manifestName === 'latest-mac.yml' ? 'at least one mac ZIP' : 'a win-x64 NSIS EXE'}`)
  if (Object.hasOwn(manifest, 'path')) {
    validateArtifactPath(manifest.path)
    const file = manifest.files.find(entry => entry.url === manifest.path)
    requireValue(file, `${manifestName}: path must reference a files entry`)
    validateHash(manifest.sha512, `${manifestName}: sha512`)
    requireValue(manifest.sha512 === file.sha512, `${manifestName}: legacy sha512 does not match files entry`)
    if (Object.hasOwn(manifest, 'size')) {
      validateSize(manifest.size, `${manifestName}: size`)
      requireValue(manifest.size === file.size, `${manifestName}: legacy size does not match files entry`)
    }
  } else {
    requireValue(!Object.hasOwn(manifest, 'sha512') && !Object.hasOwn(manifest, 'size'), `${manifestName}: legacy sha512/size requires path`)
  }
  // Preserve builder fields such as releaseDate, releaseNotes and blockMapSize.
  return manifest
}

export function validateManifestSet(manifests, { requireAllPlatforms = false } = {}) {
  requireValue(manifests.length > 0, 'at least one latest*.yml manifest is required')
  const versions = new Set(manifests.map(entry => entry.manifest.version))
  requireValue(versions.size === 1, 'manifest versions must match within a channel')
  if (requireAllPlatforms) {
    const present = new Set()
    for (const { manifest } of manifests) {
      for (const file of manifest.files) {
        const name = basename(file.url)
        for (const [platform, ext] of [['win-x64', 'exe'], ['mac-arm64', 'zip'], ['mac-x64', 'zip']]) {
          if (name === `SEP-Client-${manifest.version}-${platform}.${ext}`) present.add(platform)
        }
      }
    }
    const missing = ['win-x64', 'mac-arm64', 'mac-x64'].filter(platform => !present.has(platform))
    requireValue(missing.length === 0, `missing required platforms: ${missing.join(', ')}`)
  }
}

export async function readBounded(stream, limit = MAX_MANIFEST_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.length
    requireValue(size <= limit, `manifest exceeds maximum size of ${limit} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

// No installer-sized buffers: check the count while hashing each chunk.
export async function verifyStream(stream, file) {
  const hash = createHash('sha512')
  let size = 0
  for await (const chunk of stream) {
    size += chunk.length
    requireValue(size <= file.size, `${file.url}: size mismatch (download exceeds ${file.size})`)
    hash.update(chunk)
  }
  requireValue(size === file.size, `${file.url}: size mismatch (expected ${file.size}, received ${size})`)
  const sha512 = hash.digest('base64')
  requireValue(sha512 === file.sha512, `${file.url}: SHA512 hash mismatch`)
  return { url: file.url, size, sha512 }
}

async function openContainedFile(root, name) {
  const target = await realpath(resolve(root, name))
  const difference = relative(root, target)
  requireValue(difference !== '' && difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference), `${name}: symlink/path escapes update directory`)
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat()
    requireValue(metadata.isFile(), `${name}: must be a regular file`)
    return { handle, metadata }
  } catch (error) {
    await handle.close()
    throw error
  }
}

export async function verifyUpdateDirectory(directory, { manifestName, requireAllPlatforms = false } = {}) {
  if (manifestName) validateManifestName(manifestName)
  const root = await realpath(resolve(directory))
  requireValue((await stat(root)).isDirectory(), 'update directory must be a directory')
  const manifests = []
  for (const name of manifestName ? [manifestName] : MANIFEST_NAMES) {
    let opened
    try {
      opened = await openContainedFile(root, name)
    } catch (error) {
      if (!manifestName && error.code === 'ENOENT') {
        // A dangling symlink is a broken existing manifest, not an absent platform.
        try { await lstat(resolve(root, name)) } catch (missing) {
          if (missing.code === 'ENOENT') continue
          throw missing
        }
      }
      throw error
    }
    const { handle, metadata } = opened
    let manifest
    try {
      requireValue(metadata.size <= MAX_MANIFEST_BYTES, `${name}: manifest exceeds maximum size`)
      manifest = parseManifest(await readBounded(handle.createReadStream({ autoClose: false })), name)
    } finally {
      await handle.close()
    }
    manifests.push({ name, manifest })
  }
  validateManifestSet(manifests, { requireAllPlatforms })
  const results = []
  for (const { name, manifest } of manifests) {
    const files = []
    for (const file of manifest.files) {
      const { handle, metadata } = await openContainedFile(root, file.url)
      try {
        requireValue(metadata.size === file.size, `${file.url}: size mismatch (expected ${file.size}, received ${metadata.size})`)
        files.push(await verifyStream(handle.createReadStream({ autoClose: false }), file))
      } finally {
        await handle.close()
      }
    }
    results.push({ name, version: manifest.version, files })
  }
  return results
}

export async function main(args = process.argv.slice(2)) {
  const usage = 'usage: node scripts/verify-update-manifest.mjs <dir> [latest.yml|latest-mac.yml] [--require-all-platforms]'
  let directory
  let manifestName
  let requireAllPlatforms = false
  for (const arg of args) {
    if (arg === '--require-all-platforms' && !requireAllPlatforms) requireAllPlatforms = true
    else if (arg.startsWith('--')) throw new Error(usage)
    else if (!directory) directory = arg
    else if (!manifestName) manifestName = validateManifestName(arg)
    else throw new Error(usage)
  }
  requireValue(directory, usage)
  const results = await verifyUpdateDirectory(directory, { manifestName, requireAllPlatforms })
  for (const result of results) console.log(`verified ${result.name}: ${result.version}, ${result.files.length} artifacts (size + SHA512)`)
  return results
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main()
  } catch (error) {
    console.error(`update manifest verification failed: ${error.message}`)
    process.exitCode = 1
  }
}
