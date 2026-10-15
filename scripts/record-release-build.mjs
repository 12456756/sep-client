import { createHash, randomUUID } from 'node:crypto'
import { constants, realpathSync } from 'node:fs'
import { link, lstat, open, realpath, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyReleaseSignatures } from './verify-release-signatures.mjs'
import { MAX_MANIFEST_BYTES, parseManifest, verifyUpdateDirectory } from './verify-update-manifest.mjs'

const REPORT_NAME = 'release-build.json'
const USAGE = 'usage: node scripts/record-release-build.mjs beta|stable --commit <40 lowercase hex> [--root <dir>]'
const CLI_ERROR = 'Release build recording failed. Check arguments, native signatures, current artifacts, manifests, and output safety; remove an existing report explicitly before retrying.'

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

function contained(base, path) {
  const difference = relative(base, path)
  return difference !== '' && difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference)
}

function sameMetadata(a, b) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key])
}

async function directorySnapshot(path, base) {
  const metadata = await lstat(path, { bigint: true })
  requireValue(metadata.isDirectory() && !metadata.isSymbolicLink(), 'input directory is missing or unsafe')
  const canonical = await realpath(path)
  requireValue(!base || (contained(base, canonical) && canonical === path), 'input directory escapes release root')
  return { path, canonical, metadata }
}

async function recheckDirectories(directories) {
  for (const snapshot of directories) {
    const metadata = await lstat(snapshot.path, { bigint: true })
    requireValue(metadata.isDirectory() && !metadata.isSymbolicLink() && metadata.dev === snapshot.metadata.dev && metadata.ino === snapshot.metadata.ino, 'input directory changed during verification')
    requireValue(await realpath(snapshot.path) === snapshot.canonical, 'input directory changed during verification')
  }
}

async function requireAbsent(path) {
  try { await lstat(path) } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  throw new Error('release-build.json already exists; explicitly clean it or use an independent release root')
}

async function present(path) {
  try { await lstat(path); return true } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

// Hash the open descriptor, then check both it and the pathname for replacement/mutation.
// Only the bounded package/manifest metadata is retained in memory, never installers.
async function snapshotFile(base, name, { textLimit } = {}) {
  const path = resolve(base, name)
  requireValue(contained(base, path), 'input file escapes release directory')
  const before = await lstat(path, { bigint: true })
  requireValue(before.isFile() && !before.isSymbolicLink() && before.size > 0n && before.size <= BigInt(Number.MAX_SAFE_INTEGER), 'input must be a nonempty regular file without symlinks')
  requireValue(await realpath(path) === path, 'input file contains a symbolic link or escapes release directory')
  if (textLimit) requireValue(before.size <= BigInt(textLimit), 'release metadata exceeds size limit')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    requireValue(sameMetadata(before, await handle.stat({ bigint: true })), 'input file changed before hashing')
    const sha256 = createHash('sha256')
    const sha512 = createHash('sha512')
    const chunks = []
    let size = 0
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length
      requireValue(size <= Number(before.size), 'input file changed while hashing')
      sha256.update(chunk)
      sha512.update(chunk)
      if (textLimit) chunks.push(chunk)
    }
    const after = await lstat(path, { bigint: true })
    requireValue(size === Number(before.size) && !after.isSymbolicLink() && after.isFile() && sameMetadata(before, after) && sameMetadata(before, await handle.stat({ bigint: true })), 'input file changed while hashing')
    requireValue(await realpath(path) === path, 'input file changed while hashing')
    return {
      base, metadata: after,
      file: { name, size, sha256: sha256.digest('hex'), sha512: sha512.digest('base64') },
      ...(textLimit ? { bytes: Buffer.concat(chunks, size) } : {}),
    }
  } finally {
    await handle.close()
  }
}

async function recheckSources(sources) {
  for (const snapshot of sources) {
    const current = await snapshotFile(snapshot.base, snapshot.file.name)
    requireValue(sameMetadata(snapshot.metadata, current.metadata) && snapshot.file.size === current.file.size && snapshot.file.sha256 === current.file.sha256 && snapshot.file.sha512 === current.file.sha512, 'release source changed during verification')
  }
  // A later hash must not hide a change to a source that was already rehashed.
  for (const snapshot of sources) {
    const path = resolve(snapshot.base, snapshot.file.name)
    const metadata = await lstat(path, { bigint: true })
    requireValue(metadata.isFile() && !metadata.isSymbolicLink() && sameMetadata(snapshot.metadata, metadata) && await realpath(path) === path, 'release source changed before publication')
  }
}

function sameSet(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && new Set(actual).size === actual.length && actual.every(value => expected.includes(value))
}

function validateManifestReferences(manifest, artifacts, platform) {
  const references = manifest.files.map(file => file.url)
  requireValue(references.every(name => artifacts.includes(name)), 'manifest reference set must contain only current platform distribution files')
  const required = platform === 'darwin' ? artifacts.filter(name => name.endsWith('.zip')) : artifacts
  requireValue(required.every(name => references.includes(name)), 'manifest reference set is missing a required current platform artifact')
}

function validateManifestResult(results, manifestName, manifest, sources) {
  requireValue(Array.isArray(results) && results.length === 1, 'manifest verifier must verify exactly the native platform manifest')
  const result = results[0]
  requireValue(result?.name === manifestName && result.version === manifest.version && sameSet(result.files?.map(file => file.url), manifest.files.map(file => file.url)), 'verified manifest version/reference set differs from input')
  const byName = new Map(sources.map(source => [source.file.name, source.file]))
  for (const reference of manifest.files) {
    const verified = result.files.find(file => file.url === reference.url)
    const source = byName.get(reference.url)
    requireValue(source && reference.size === source.size && reference.sha512 === source.sha512 && verified.size === source.size && verified.sha512 === source.sha512, 'verified manifest digest differs from recorded source')
  }
}

async function atomicReport(directory, report, verifySources) {
  const output = join(directory, REPORT_NAME)
  await requireAbsent(output)
  const temporary = join(directory, `.release-build-${randomUUID()}.tmp`)
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, 'utf8')
    await handle.sync()
    await verifySources()
    await requireAbsent(output)
    const metadata = await lstat(temporary, { bigint: true })
    requireValue(metadata.isFile() && !metadata.isSymbolicLink() && sameMetadata(metadata, await handle.stat({ bigint: true })), 'temporary report changed before publication')
    // Unlike rename, link publishes a complete file atomically without replacing any destination.
    await link(temporary, output)
  } finally {
    await handle.close()
    await unlink(temporary)
  }
}

/** commit is the caller's declared build source, not independent proof of provenance. */
export async function recordReleaseBuild(channel, {
  commit,
  root = process.cwd(),
  platform = process.platform,
  env = process.env,
  signatureVerifier = verifyReleaseSignatures,
  manifestVerifier = verifyUpdateDirectory,
  runner,
  archiveReader,
} = {}) {
  requireValue(channel === 'beta' || channel === 'stable', 'channel must be beta or stable')
  requireValue(typeof commit === 'string' && commit.length === 40 && /^[0-9a-f]{40}$/.test(commit), 'commit must be exactly 40 lowercase hexadecimal characters')
  requireValue(platform === 'darwin' || platform === 'win32', 'release build recording requires native macOS or Windows')
  requireValue(typeof signatureVerifier === 'function' && typeof manifestVerifier === 'function', 'release verifiers are required')
  // Cross-platform injection is for tests only; production defaults always use the native host.
  requireValue(signatureVerifier !== verifyReleaseSignatures || runner !== undefined || platform === process.platform, 'native signature verification must run on its own platform')

  const requestedRoot = resolve(root)
  const rootSnapshot = await directorySnapshot(requestedRoot)
  root = rootSnapshot.canonical
  const dist = join(root, 'dist')
  const directory = join(dist, channel)
  const directories = [rootSnapshot, await directorySnapshot(dist, root), await directorySnapshot(directory, dist)]
  await requireAbsent(join(directory, REPORT_NAME))
  const packageSource = await snapshotFile(root, 'package.json', { textLimit: MAX_MANIFEST_BYTES })
  let pkg
  try { pkg = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(packageSource.bytes)) } catch { throw new Error('cannot parse package.json') }
  const manifestName = platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml'
  const manifestSource = await snapshotFile(directory, manifestName, { textLimit: MAX_MANIFEST_BYTES })
  const manifest = parseManifest(manifestSource.bytes, manifestName)
  requireValue(pkg?.version === manifest.version, 'manifest version must match current package version')
  const version = manifest.version
  const artifacts = platform === 'darwin'
    ? ['x64', 'arm64'].flatMap(arch => ['dmg', 'zip'].map(ext => `SEP-Client-${version}-mac-${arch}.${ext}`))
    : [`SEP-Client-${version}-win-x64.exe`]
  validateManifestReferences(manifest, artifacts, platform)

  async function fileNames() {
    const names = [...artifacts, manifestName]
    for (const artifact of artifacts) {
      const blockmap = `${artifact}.blockmap`
      if (platform === 'win32' || await present(join(directory, blockmap))) names.push(blockmap)
    }
    return names.sort()
  }
  const names = await fileNames()
  const sources = []
  for (const name of names) sources.push(name === manifestName ? manifestSource : await snapshotFile(directory, name))
  const checkedPaths = artifacts.map(name => join(directory, name))
  const signatureSources = []
  if (platform === 'win32') {
    const product = pkg.build?.productName
    requireValue(typeof product === 'string' && product.trim().length > 0, 'build.productName is invalid')
    requireValue([...product].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
      && !/[<>:"/\\|?*]/.test(product) && !product.includes('[') && !product.includes(']') && !/[. ]$/.test(product), 'build.productName is invalid')
    const unpacked = join(directory, 'win-unpacked')
    directories.push(await directorySnapshot(unpacked, directory))
    signatureSources.push(await snapshotFile(unpacked, `${product}.exe`))
    checkedPaths.push(join(unpacked, `${product}.exe`))
  }
  await recheckDirectories(directories)
  const signature = await signatureVerifier(channel, { root, platform, env, runner, archiveReader })
  requireValue(signature?.channel === channel && signature.platform === platform && signature.version === version && sameSet(signature.files, checkedPaths), 'signature verifier result differs from current release inputs')
  const results = await manifestVerifier(directory, { manifestName })
  validateManifestResult(results, manifestName, manifest, sources)
  const report = { schemaVersion: 1, channel, version, commit, platform, signatureVerified: true, files: sources.map(source => source.file) }
  await atomicReport(directory, report, async () => {
    await recheckDirectories(directories)
    requireValue(sameSet(await fileNames(), names), 'distribution file set changed during verification')
    await recheckSources([packageSource, ...sources, ...signatureSources])
    requireValue(sameSet(await fileNames(), names), 'distribution file set changed before publication')
    await recheckDirectories(directories)
  })
  return report
}

export async function main(args = process.argv.slice(2), options = {}) {
  const [channel, ...flags] = args
  requireValue(channel === 'beta' || channel === 'stable', USAGE)
  const parsed = {}
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index]
    const key = flag === '--commit' ? 'commit' : flag === '--root' ? 'root' : undefined
    const value = flags[index + 1]
    requireValue(key && !Object.hasOwn(parsed, key) && typeof value === 'string' && value.length > 0 && !value.startsWith('--'), USAGE)
    parsed[key] = value
  }
  requireValue(Object.hasOwn(parsed, 'commit'), USAGE)
  return recordReleaseBuild(channel, { ...options, ...parsed })
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const report = await main()
    console.log(`release build recorded: ${report.channel}, ${report.platform}, ${report.files.length} files`)
  } catch {
    // Never echo arguments, paths, subprocess diagnostics, or arbitrary verifier errors.
    console.error(CLI_ERROR)
    process.exitCode = 1
  }
}
