import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const MAC = Object.freeze({ codesign: '/usr/bin/codesign', hdiutil: '/usr/bin/hdiutil', unzip: '/usr/bin/unzip', ditto: '/usr/bin/ditto', spctl: '/usr/sbin/spctl', xcrun: '/usr/bin/xcrun', plutil: '/usr/bin/plutil', lipo: '/usr/bin/lipo' })

// Paths and publisher names are data, never PowerShell source or command-line literals.
const WINDOWS_CHECK = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $signature = Get-AuthenticodeSignature -LiteralPath $env:SEP_SIGNATURE_FILE
  $certificate = $signature.SignerCertificate
  $matches = $false
  if ($null -ne $certificate) {
    $subject = $certificate.SubjectName.Decode([System.Security.Cryptography.X509Certificates.X500DistinguishedNameFlags]::UseNewLines)
    $commonNames = @($subject -split "\r?\n" | Where-Object { $_ -cmatch '^CN=' })
    $matches = ($commonNames.Count -eq 1) -and ($certificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -ceq $env:SEP_SIGNATURE_PUBLISHER)
  }
  [ordered]@{
    valid = ($signature.Status -eq [System.Management.Automation.SignatureStatus]::Valid)
    publisherMatches = [bool]$matches
    timestamped = ($null -ne $signature.TimeStamperCertificate)
  } | ConvertTo-Json -Compress
} catch { exit 1 }
`

export async function runCommand(command, args, options) {
  return execute(command, args, { ...options, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, shell: false })
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

function hasControlCharacters(value) {
  return [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
}

async function commandResult(runner, env, command, args, label, extraEnv = {}) {
  try {
    const result = await runner(command, args, { env: { ...env, ...extraEnv, LC_ALL: 'C' } })
    requireValue(result && (result.code === undefined || result.code === 0) && (result.signal === undefined || result.signal === null), label)
    requireValue(typeof result.stdout === 'string' && typeof result.stderr === 'string', label)
    return result
  } catch {
    // Neither subprocess diagnostics nor their Error/cause objects are release-log safe.
    throw new Error(label)
  }
}

function isContained(base, target) {
  const difference = relative(base, target)
  return difference !== '' && difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference)
}

async function requireContained(base, file, directory = false) {
  try {
    const metadata = await lstat(file)
    requireValue(!metadata.isSymbolicLink() && (directory ? metadata.isDirectory() : metadata.isFile()), 'invalid artifact')
    requireValue(isContained(await realpath(base), await realpath(file)), 'invalid artifact')
  } catch {
    throw new Error(directory ? 'expected packaged application is missing or unsafe' : 'required current-version artifact is missing or unsafe')
  }
}

export function validateMacIdentity(text, { appId, teamId, requireRuntime = true }) {
  const lines = text.split(/\r?\n/)
  const values = key => lines.filter(line => line.startsWith(`${key}=`)).map(line => line.slice(key.length + 1))
  const teams = values('TeamIdentifier')
  requireValue(teams.length === 1 && teams[0] === teamId, 'macOS signing team does not match SEP_MAC_TEAM_ID')
  const authorities = values('Authority')
  requireValue(authorities.length > 0 && authorities[0].startsWith('Developer ID Application: ') && authorities[0].endsWith(` (${teamId})`), 'macOS signature requires Developer ID Application authority')
  if (appId !== undefined) {
    const identifiers = values('Identifier')
    requireValue(identifiers.length === 1 && identifiers[0] === appId, 'macOS application identifier does not match build.appId')
  }
  if (requireRuntime) {
    const flags = lines.filter(line => line.startsWith('CodeDirectory ')).map(line => /\bflags=0x([0-9a-fA-F]+)(?:\(|\s|$)/.exec(line))
    requireValue(flags.length === 1 && flags[0] && (BigInt(`0x${flags[0][1]}`) & 0x10000n) !== 0n, 'macOS application requires hardened runtime')
  }
}

export function validateArchiveEntries(text) {
  requireValue(typeof text === 'string' && text.length > 0, 'ZIP entry listing is empty or invalid')
  const entries = text.replace(/\n$/, '').split('\n')
  const seen = new Set()
  for (const entry of entries) {
    const name = entry.endsWith('/') ? entry.slice(0, -1) : entry
    requireValue(name.length > 0 && !hasControlCharacters(name) && !/[\\:]/.test(name) && !name.startsWith('/'), 'ZIP contains an unsafe entry path')
    requireValue(name.split('/').every(part => part && part !== '.' && part !== '..'), 'ZIP contains an unsafe entry path')
    const key = name.normalize('NFC').toLowerCase()
    requireValue(!seen.has(key), 'ZIP contains duplicate or colliding entry paths')
    seen.add(key)
  }
  return entries
}

export async function readZipEntries(file, { maxUncompressedBytes = 8 * 1024 ** 3 } = {}) {
  let zip
  try {
    requireValue(Number.isSafeInteger(maxUncompressedBytes) && maxUncompressedBytes > 0, 'ZIP size limit is invalid')
    // Already installed through Electron/extract-zip; no new release dependency.
    const { default: yauzl } = await import('yauzl')
    zip = await new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, autoClose: false, decodeStrings: false }, (error, value) => error ? reject(error) : resolve(value)))
    const records = []
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let nameBytes = 0
    let uncompressedBytes = 0
    await new Promise((resolve, reject) => {
      zip.on('error', reject)
      zip.on('end', resolve)
      zip.on('entry', entry => {
        const inspect = async () => {
          requireValue(records.length < 100_000 && (nameBytes += entry.fileName.length) <= 16 * 1024 * 1024, 'ZIP metadata is too large')
          uncompressedBytes += entry.uncompressedSize
          requireValue(Number.isSafeInteger(uncompressedBytes) && uncompressedBytes <= maxUncompressedBytes, 'ZIP uncompressed content is too large')
          const name = decoder.decode(entry.fileName)
          // Native ditto uses raw UTF-8 names even without the ZIP UTF-8 flag.
          // Reject alternate Unicode names that another extractor could interpret differently.
          for (const field of entry.extraFields.filter(field => field.id === 0x7075)) {
            requireValue(field.data.length >= 5 && field.data.subarray(5).equals(entry.fileName), 'ZIP has inconsistent Unicode entry names')
          }
          const type = (entry.externalFileAttributes >>> 16) & 0o170000
          requireValue([0, 0o040000, 0o100000, 0o120000].includes(type), 'ZIP contains unsupported entry types')
          const record = { name, mode: type === 0o120000 ? 'l' : name.endsWith('/') ? 'd' : '-' }
          if (record.mode === 'l') {
            requireValue(entry.uncompressedSize > 0 && entry.uncompressedSize <= 4096, 'ZIP symbolic link target is invalid')
            const stream = await new Promise((resolve, reject) => zip.openReadStream(entry, (error, value) => error ? reject(error) : resolve(value)))
            const chunks = []
            let bytes = 0
            await new Promise((resolve, reject) => {
              stream.on('error', reject)
              stream.on('end', resolve)
              stream.on('data', chunk => {
                bytes += chunk.length
                if (bytes > 4096) {
                  stream.destroy()
                  reject(new Error('ZIP symbolic link target is too large'))
                } else chunks.push(chunk)
              })
            })
            record.target = decoder.decode(Buffer.concat(chunks))
          }
          records.push(record)
          zip.readEntry()
        }
        inspect().catch(reject)
      })
      zip.readEntry()
    })
    return records
  } catch {
    throw new Error('ZIP metadata or symbolic link inspection failed')
  } finally {
    zip?.close()
  }
}

async function preflightZip(file, appName, run, archiveReader) {
  // macOS unzip's display is lossy for UTF-8 names; use it only for traversal
  // checks, then validate exact names/types/targets with the installed parser.
  const listing = (await run(MAC.unzip, ['-Z1', file], 'cannot list ZIP entries')).stdout
  for (const entry of listing.replace(/\n$/, '').split('\n')) validateArchiveEntries(`${entry}\n`)
  const records = await archiveReader(file)
  requireValue(Array.isArray(records) && records.length > 0 && records.every(record => typeof record?.name === 'string' && ['d', 'l', '-'].includes(record.mode)), 'ZIP entry metadata is invalid')
  const entries = validateArchiveEntries(`${records.map(record => record.name).join('\n')}\n`)
  requireValue(entries.length === listing.replace(/\n$/, '').split('\n').length, 'ZIP entry metadata is inconsistent')
  requireValue(entries.some(entry => entry.startsWith(`${appName}/`)), 'ZIP does not contain the expected application')
  requireValue(entries.every(entry => entry === appName || entry.startsWith(`${appName}/`) || entry === '__MACOSX/' || entry.startsWith('__MACOSX/')), 'ZIP contains unexpected top-level content')
  const links = new Map()
  const pathKey = name => name.normalize('NFC').toLowerCase()
  for (const record of records.filter(record => record.mode === 'l')) {
    const target = record.target
    requireValue(typeof target === 'string' && target.length > 0 && !hasControlCharacters(target) && !/[\\:]/.test(target) && !target.startsWith('/'), 'ZIP contains an unsafe symbolic link')
    links.set(pathKey(record.name), target)
  }
  function resolveLinks(name) {
    const pending = name.split('/')
    const parts = []
    let followed = 0
    while (pending.length) {
      const part = pending.shift()
      if (!part || part === '.') continue
      if (part === '..') {
        requireValue(parts.length > 1, 'ZIP symbolic link escapes the application')
        parts.pop()
        continue
      }
      parts.push(part)
      requireValue(pathKey(parts[0]) === pathKey(appName), 'ZIP symbolic link escapes the application')
      const prefix = pathKey(parts.join('/'))
      if (links.has(prefix)) {
        requireValue(++followed < 40, 'ZIP contains cyclic symbolic links')
        parts.pop()
        pending.unshift(...links.get(prefix).split('/'))
      }
    }
  }
  for (const record of records.filter(record => record.mode === 'l')) resolveLinks(record.name)
}

async function verifyBundleContainment(app) {
  const base = await realpath(app)
  let count = 0
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      requireValue(++count <= 100_000, 'macOS application has too many filesystem entries')
      const file = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        let target
        try { target = await realpath(file) } catch { throw new Error('macOS application has an invalid symbolic link') }
        requireValue(target === base || isContained(base, target), 'macOS application symbolic link escapes its bundle')
      } else if (entry.isDirectory()) await visit(file)
      else requireValue(entry.isFile(), 'macOS application contains an unsupported filesystem entry')
    }
  }
  await visit(app)
}

async function verifyApp(directory, appName, identity, run) {
  const app = join(directory, appName)
  await requireContained(directory, app, true)
  await verifyBundleContainment(app)
  const plist = join(app, 'Contents', 'Info.plist')
  await requireContained(app, plist)
  const bundleVersion = await run(MAC.plutil, ['-extract', 'CFBundleShortVersionString', 'raw', '-expect', 'string', '-o', '-', plist], 'cannot inspect macOS bundle version')
  requireValue(bundleVersion.stdout.replace(/\n$/, '') === identity.version, 'macOS bundle version does not match current package version')
  const executableInfo = await run(MAC.plutil, ['-extract', 'CFBundleExecutable', 'raw', '-expect', 'string', '-o', '-', plist], 'cannot inspect macOS bundle executable')
  const name = executableInfo.stdout.replace(/\n$/, '')
  requireValue(name.length > 0 && name !== '.' && name !== '..' && !hasControlCharacters(name) && !/[\\/:]/.test(name), 'macOS bundle executable name is unsafe')
  const executable = join(app, 'Contents', 'MacOS', name)
  await requireContained(app, executable)
  const architectures = await run(MAC.lipo, ['-archs', executable], 'cannot inspect macOS executable architecture')
  requireValue(architectures.stdout.trim() === identity.arch, 'macOS executable architecture does not match artifact architecture')
  await run(MAC.codesign, ['--verify', '--deep', '--strict', app], 'macOS application signature verification failed')
  const display = await run(MAC.codesign, ['-dv', '--verbose=4', app], 'cannot inspect macOS application signature')
  validateMacIdentity(`${display.stdout}\n${display.stderr}`, identity)
  await run(MAC.spctl, ['--assess', '--type', 'execute', app], 'macOS application trust assessment failed')
  await run(MAC.xcrun, ['stapler', 'validate', app], 'macOS application stapled ticket validation failed')
}

async function verifyDmg(file, appName, identity, run) {
  await run(MAC.codesign, ['--verify', '--strict', file], 'DMG signature verification failed')
  const display = await run(MAC.codesign, ['-dv', '--verbose=4', file], 'cannot inspect DMG signature')
  validateMacIdentity(`${display.stdout}\n${display.stderr}`, { teamId: identity.teamId, requireRuntime: false })
  const temporary = await mkdtemp(join(tmpdir(), 'sep-signature-dmg-'))
  const mountpoint = join(temporary, 'mount')
  let attempted = false
  let detached = true
  try {
    await mkdir(mountpoint)
    attempted = true
    detached = false
    await run(MAC.hdiutil, ['attach', '-readonly', '-nobrowse', '-mountpoint', mountpoint, file], 'cannot mount DMG read-only')
    await verifyApp(mountpoint, appName, identity, run)
  } finally {
    if (attempted) {
      try {
        await run(MAC.hdiutil, ['detach', mountpoint], 'cannot detach temporary DMG mount')
        detached = true
      } catch {
        await run(MAC.hdiutil, ['detach', '-force', mountpoint], 'cannot detach temporary DMG mount')
        detached = true
      }
    }
    // Never recursively remove a volume if both detach attempts failed.
    if (detached) await rm(temporary, { recursive: true, force: true })
  }
}

async function verifyZip(file, appName, identity, run, archiveReader) {
  await preflightZip(file, appName, run, archiveReader)
  const temporary = await mkdtemp(join(tmpdir(), 'sep-signature-zip-'))
  try {
    await run(MAC.ditto, ['-x', '-k', file, temporary], 'cannot extract ZIP application')
    await verifyApp(temporary, appName, identity, run)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function verifyWindows(file, publisher, run) {
  const result = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_CHECK], 'Windows Authenticode inspection failed', { SEP_SIGNATURE_FILE: file, SEP_SIGNATURE_PUBLISHER: publisher })
  let signature
  try { signature = JSON.parse(result.stdout.replace(/^\uFEFF/, '')) } catch { throw new Error('Windows Authenticode response is invalid') }
  requireValue(signature?.valid === true, 'Windows Authenticode signature must have status Valid')
  requireValue(signature.publisherMatches === true, 'Windows signer CN does not match SEP_WINDOWS_PUBLISHER')
  requireValue(signature.timestamped === true, 'Windows Authenticode signature requires a timestamp')
}

export async function verifyReleaseSignatures(channel, { root = process.cwd(), platform = process.platform, env = process.env, runner = runCommand, archiveReader = readZipEntries } = {}) {
  requireValue(channel === 'beta' || channel === 'stable', 'channel must be beta or stable')
  requireValue(platform === 'darwin' || platform === 'win32', 'native signature verification requires macOS or Windows')
  requireValue(!env.SEP_RELEASE_CHANNEL || env.SEP_RELEASE_CHANNEL === channel, 'SEP_RELEASE_CHANNEL conflicts with the requested channel')
  if (platform === 'darwin') requireValue(typeof env.SEP_MAC_TEAM_ID === 'string' && /^[A-Z0-9]{10}$/.test(env.SEP_MAC_TEAM_ID), 'SEP_MAC_TEAM_ID must contain exactly 10 uppercase alphanumeric characters')
  else requireValue(typeof env.SEP_WINDOWS_PUBLISHER === 'string' && env.SEP_WINDOWS_PUBLISHER.trim().length > 0 && !hasControlCharacters(env.SEP_WINDOWS_PUBLISHER), 'SEP_WINDOWS_PUBLISHER must be a nonempty signer CN')
  let pkg
  try { pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) } catch { throw new Error('cannot read current package.json') }
  requireValue(typeof pkg?.version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(pkg.version), 'package.json version is invalid')
  requireValue(typeof pkg.build?.appId === 'string' && /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(pkg.build.appId), 'build.appId is invalid')
  requireValue(typeof pkg.build.productName === 'string' && pkg.build.productName.trim().length > 0 && !hasControlCharacters(pkg.build.productName) && !/[<>:"/\\|?*]/.test(pkg.build.productName) && !pkg.build.productName.includes('[') && !pkg.build.productName.includes(']') && !/[. ]$/.test(pkg.build.productName), 'build.productName is invalid')
  const directory = resolve(root, 'dist', channel)
  const files = platform === 'darwin'
    ? ['x64', 'arm64'].flatMap(arch => ['dmg', 'zip'].map(ext => join(directory, `SEP-Client-${pkg.version}-mac-${arch}.${ext}`)))
    : [join(directory, `SEP-Client-${pkg.version}-win-x64.exe`), join(directory, 'win-unpacked', `${pkg.build.productName}.exe`)]
  // Require the whole host artifact set up front; no scanning or stale-version fallback.
  for (const file of files) await requireContained(directory, file)
  const run = (command, args, label, extraEnv) => commandResult(runner, env, command, args, label, extraEnv)
  for (const file of files) {
    if (platform === 'win32') await verifyWindows(file, env.SEP_WINDOWS_PUBLISHER, run)
    else {
      const identity = { appId: pkg.build.appId, teamId: env.SEP_MAC_TEAM_ID, version: pkg.version, arch: file.endsWith('-x64.dmg') || file.endsWith('-x64.zip') ? 'x86_64' : 'arm64' }
      if (file.endsWith('.dmg')) await verifyDmg(file, `${pkg.build.productName}.app`, identity, run)
      else await verifyZip(file, `${pkg.build.productName}.app`, identity, run, archiveReader)
    }
  }
  return { channel, platform, version: pkg.version, files }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    requireValue(process.argv.length === 3, 'usage: node scripts/verify-release-signatures.mjs beta|stable')
    const result = await verifyReleaseSignatures(process.argv[2])
    console.log(`native release signatures verified: ${result.channel}, ${result.platform}, ${result.files.length} artifacts`)
  } catch {
    // Also suppress unexpected filesystem errors: paths can contain private CI values.
    console.error('Native release signature verification failed. Check the channel, current artifacts, signing identity, trust, and native tools.')
    process.exitCode = 1
  }
}
