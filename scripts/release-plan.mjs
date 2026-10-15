import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import semver from 'semver'
import { UPDATE_FEEDS } from './generate-builder-config.mjs'
import { MANIFEST_NAMES, validateArtifactPath, verifyUpdateDirectory } from './verify-update-manifest.mjs'

export const MAX_RELEASE_METADATA = 1024 * 1024
export function requireRelease(condition, message) {
  if (!condition) throw new Error(message)
}
export function validateReleaseIdentity({ channel, version, commit }) {
  requireRelease(Object.hasOwn(UPDATE_FEEDS, channel), 'channel must be beta or stable')
  const parsed = typeof version === 'string' ? semver.parse(version) : null
  const canonical = parsed && `${parsed.version}${parsed.build.length ? `+${parsed.build.join('.')}` : ''}`
  requireRelease(parsed && canonical === version, 'release version must be canonical SemVer')
  requireRelease(channel !== 'stable' || !semver.prerelease(version), 'stable releases cannot use prerelease versions')
  requireRelease(typeof commit === 'string' && /^[a-f0-9]{40}$/.test(commit), 'build commit must be a full lowercase Git SHA')
}
export async function releaseDirectory(directory) {
  requireRelease(typeof directory === 'string' && !directory.includes('://'), 'a local directory is required')
  const root = resolve(directory)
  requireRelease((await lstat(root)).isDirectory(), 'release directory must be a real directory, not a symbolic link')
  return realpath(root)
}
function flatName(name) {
  validateArtifactPath(name)
  requireRelease(basename(name) === name, 'release files must be flat relative names')
}
async function openReleaseFile(directory, name) {
  flatName(name)
  const file = resolve(directory, name)
  requireRelease((await lstat(file)).isFile(), 'release file must be regular, not a symbolic link')
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    requireRelease(stat.isFile() && stat.size > 0, 'release file must be a nonempty regular file')
    return { handle, stat }
  } catch (error) {
    await handle.close()
    throw error
  }
}
export async function readReleaseBytes(directory, name, limit = MAX_RELEASE_METADATA) {
  const { handle, stat } = await openReleaseFile(directory, name)
  try {
    requireRelease(stat.size <= limit, 'release metadata is oversized')
    const buffer = Buffer.alloc(limit + 1)
    let size = 0
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null)
      if (!bytesRead) break
      size += bytesRead
    }
    const after = await handle.stat()
    requireRelease(size === stat.size && size <= limit && after.size === stat.size && after.mtimeMs === stat.mtimeMs && after.ctimeMs === stat.ctimeMs, 'release metadata changed while reading')
    return buffer.subarray(0, size)
  } finally { await handle.close() }
}
export async function hashReleaseFile(directory, name) {
  const { handle, stat } = await openReleaseFile(directory, name)
  try {
    const sha256 = createHash('sha256')
    const sha512 = createHash('sha512')
    let size = 0
    for await (const bytes of handle.createReadStream({ autoClose: false })) {
      size += bytes.length
      requireRelease(size <= stat.size, 'release file changed while hashing')
      sha256.update(bytes)
      sha512.update(bytes)
    }
    const after = await handle.stat()
    requireRelease(size === stat.size && after.size === stat.size && after.mtimeMs === stat.mtimeMs && after.ctimeMs === stat.ctimeMs, 'release file changed while hashing')
    return { name, size, sha256: sha256.digest('hex'), sha512: sha512.digest('base64') }
  } finally { await handle.close() }
}
export function sameReleaseFile(left, right) {
  return left.name === right.name && left.size === right.size && left.sha256 === right.sha256 && left.sha512 === right.sha512
}
export function validateReleaseFile(file) {
  requireRelease(file && typeof file.name === 'string', 'release file descriptor is invalid')
  flatName(file.name)
  requireRelease(Number.isSafeInteger(file.size) && file.size > 0 && typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/.test(file.sha256) && typeof file.sha512 === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(file.sha512) && Buffer.from(file.sha512, 'base64').toString('base64') === file.sha512, 'build receipt hash or size is invalid')
}
export async function copyReleaseFile(source, target, file) {
  const { handle } = await openReleaseFile(source, file.name)
  let output
  try {
    output = await open(resolve(target, file.name), 'wx', 0o600)
    let size = 0
    for await (const bytes of handle.createReadStream({ autoClose: false })) {
      size += bytes.length
      requireRelease(size <= file.size, 'release file changed while copying')
      await output.writeFile(bytes)
    }
    requireRelease(size === file.size, 'release file changed while copying')
    await output.sync()
  } finally {
    await handle.close()
    if (output) await output.close()
  }
  requireRelease(sameReleaseFile(await hashReleaseFile(target, file.name), file), 'copied release file hash mismatch')
}
export function requiredPlatformFiles(version, platform) {
  const prefix = `SEP-Client-${version}`
  return platform === 'darwin'
    ? ['arm64', 'x64'].flatMap(arch => ['dmg', 'zip'].map(ext => `${prefix}-mac-${arch}.${ext}`)).concat('latest-mac.yml')
    : [`${prefix}-win-x64.exe`, `${prefix}-win-x64.exe.blockmap`, 'latest.yml']
}
function allowedPlatformFiles(version, platform) {
  const required = requiredPlatformFiles(version, platform)
  return new Set([...required, ...required.filter(name => /\.(dmg|zip)$/.test(name)).map(name => name + '.blockmap')])
}
export function validateBuildReceipt(receipt, identity, platform) {
  validateReleaseIdentity(identity)
  requireRelease(receipt?.schemaVersion === 1 && receipt.platform === platform && receipt.channel === identity.channel && receipt.version === identity.version && receipt.commit === identity.commit && typeof receipt.signatureVerified === 'boolean', 'build receipt identity or provenance mismatch')
  requireRelease(Array.isArray(receipt.files) && receipt.files.length <= 16, 'build receipt files are invalid')
  const allowed = allowedPlatformFiles(identity.version, platform)
  const seen = new Set()
  const files = receipt.files.map(file => {
    requireRelease(file && allowed.has(file.name) && !seen.has(file.name), 'build receipt has unexpected or duplicate files')
    seen.add(file.name)
    validateReleaseFile(file)
    return { name: file.name, size: file.size, sha256: file.sha256, sha512: file.sha512 }
  })
  requireRelease(requiredPlatformFiles(identity.version, platform).every(name => seen.has(name)), 'build receipt is missing required platform files')
  return { schemaVersion: 1, ...identity, platform, signatureVerified: receipt.signatureVerified, files }
}
async function verifyReceipt(directory, receipt) {
  for (const file of receipt.files) requireRelease(sameReleaseFile(await hashReleaseFile(directory, file.name), file), 'build receipt does not match current file hashes')
}
function parseJson(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new Error('release metadata must be valid UTF-8 JSON') }
}
function validateNotes(bytes) {
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new Error('release notes must be valid UTF-8 text') }
  const hasControl = [...text].some(character => {
    const code = character.charCodeAt(0)
    return (code < 32 && ![9, 10, 13].includes(code)) || (code >= 127 && code <= 159)
  })
  requireRelease(text.trim().length > 0 && !hasControl, 'release notes must be nonempty plain text without binary/control characters')
}
async function rejectStaleArtifacts(root, named) {
  for (const name of await readdir(root)) {
    if (/\.(exe|dmg|zip)(\.blockmap)?$/i.test(name)) requireRelease(named.includes(name), 'unexpected or stale installer in release directory')
  }
}
function checksumText(files) {
  return [...files].sort((a, b) => a.name.localeCompare(b.name, 'en')).map(file => `${file.sha256}  ${file.name}\n`).join('')
}
export async function buildReleasePlan({ directory, channel, version, commit }) {
  const identity = { channel, version, commit }
  validateReleaseIdentity(identity)
  const root = await releaseDirectory(directory)
  const rawReceipts = parseJson(await readReleaseBytes(root, 'release-builds.json'))
  requireRelease(Array.isArray(rawReceipts) && rawReceipts.length === 2, 'both native build receipts are required')
  const receipts = ['darwin', 'win32'].map(platform => {
    requireRelease(rawReceipts.filter(receipt => receipt?.platform === platform).length === 1, 'native build receipts must be unique')
    return validateBuildReceipt(rawReceipts.find(receipt => receipt?.platform === platform), identity, platform)
  })
  const named = receipts.flatMap(receipt => receipt.files.map(file => file.name))
  await rejectStaleArtifacts(root, named)
  for (const receipt of receipts) await verifyReceipt(root, receipt)
  const manifests = await verifyUpdateDirectory(root, { requireAllPlatforms: true })
  requireRelease(manifests.every(manifest => manifest.version === version && manifest.files.every(file => named.includes(file.url))), 'manifest does not match the approved release inputs')
  const artifacts = receipts.flatMap(receipt => receipt.files.filter(file => !MANIFEST_NAMES.includes(file.name))).sort((a, b) => a.name.localeCompare(b.name, 'en'))
  requireRelease((await readReleaseBytes(root, 'SHA256SUMS.txt')).toString('utf8') === checksumText(artifacts), 'release SHA256SUMS does not match the complete artifact set')
  const metadataNames = ['release-builds.json', `RELEASE-NOTES-${channel}.md`, 'SHA256SUMS.txt']
  const metadata = []
  for (const name of metadataNames) {
    const bytes = await readReleaseBytes(root, name, name.startsWith('RELEASE-NOTES') ? 128 * 1024 : MAX_RELEASE_METADATA)
    if (name.startsWith('RELEASE-NOTES')) validateNotes(bytes)
    metadata.push(await hashReleaseFile(root, name))
  }
  const manifestFiles = []
  for (const name of MANIFEST_NAMES) manifestFiles.push(await hashReleaseFile(root, name))
  return {
    schemaVersion: 1, mode: 'local-rehearsal', releaseApproved: false, ...identity,
    candidateFeed: UPDATE_FEEDS[channel],
    platforms: receipts.map(({ platform, signatureVerified }) => ({ platform, signatureVerified })),
    files: [...artifacts.map(file => ({ ...file, phase: 'artifact' })), ...metadata.map(file => ({ ...file, phase: 'metadata' })), ...manifestFiles.map(file => ({ ...file, phase: 'manifest' }))],
    warnings: ['Native receipt claims are not independent build provenance or Phase 3 acceptance.', 'Remote publishing and production approval are not enabled.'],
  }
}
export async function collectRelease({ channel, version, commit, mac, win, output, notes }) {
  const identity = { channel, version, commit }
  validateReleaseIdentity(identity)
  requireRelease(typeof output === 'string' && !output.includes('://'), 'collection output must be a local path')
  const destination = resolve(output)
  try { await lstat(destination); throw new Error('collection output already exists') } catch (error) { if (error.code !== 'ENOENT') throw error }
  const sources = []
  for (const [platform, directory] of [['darwin', mac], ['win32', win]]) {
    const root = await releaseDirectory(directory)
    const receipt = validateBuildReceipt(parseJson(await readReleaseBytes(root, 'release-build.json')), identity, platform)
    await rejectStaleArtifacts(root, receipt.files.map(file => file.name))
    await verifyReceipt(root, receipt)
    const result = await verifyUpdateDirectory(root, { manifestName: platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml' })
    requireRelease(result[0].version === version, 'native manifest version mismatch')
    sources.push({ root, receipt })
  }
  await mkdir(dirname(destination), { recursive: true })
  const staging = await mkdtemp(resolve(dirname(destination), '.sep-release-collect-'))
  try {
    for (const source of sources) for (const file of source.receipt.files) await copyReleaseFile(source.root, staging, file)
    const receipts = sources.map(source => source.receipt)
    await writeFile(resolve(staging, 'release-builds.json'), JSON.stringify(receipts, null, 2) + '\n', { flag: 'wx' })
    const bytes = notes ? await readReleaseBytes(dirname(resolve(notes)), basename(notes), 128 * 1024) : Buffer.from(`# SEP Client ${version} (${channel})\n\n- Build commit: ${commit}\n- Release assembly only; production acceptance remains pending.\n`)
    requireRelease(bytes.length > 0 && bytes.length <= 128 * 1024, 'release notes must be nonempty bounded UTF-8 text')
    validateNotes(bytes)
    await writeFile(resolve(staging, `RELEASE-NOTES-${channel}.md`), bytes, { flag: 'wx' })
    await writeFile(resolve(staging, 'SHA256SUMS.txt'), checksumText(receipts.flatMap(receipt => receipt.files.filter(file => !MANIFEST_NAMES.includes(file.name)))), { flag: 'wx' })
    const plan = await buildReleasePlan({ ...identity, directory: staging })
    // Reserve the destination before moving files; never replace an existing bundle.
    await mkdir(destination)
    try {
      for (const name of await readdir(staging)) await rename(resolve(staging, name), resolve(destination, name))
    } catch (error) {
      await rm(destination, { recursive: true, force: true })
      throw error
    }
    return plan
  } finally { await rm(staging, { recursive: true, force: true }) }
}
