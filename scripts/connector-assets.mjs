import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { zipSync } from 'fflate'
import { prepareDingTalk } from './dingtalk-assets.mjs'
import { prepareFeishu } from './feishu-assets.mjs'
import { prepareWecom } from './wecom-assets.mjs'

const require = createRequire(import.meta.url)
const execute = promisify(execFile)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const specs = [
  { id: 'dingtalk', version: '1.0.68', binary: 'dws', prepare: prepareDingTalk },
  { id: 'feishu', version: '1.0.100', binary: 'lark-cli', prepare: prepareFeishu },
  { id: 'wecom', version: '1.3.4', binary: 'wecom-cli', prepare: prepareWecom },
]

async function signBinary(context, binary) {
  if (context.electronPlatformName === 'win32') {
    if (context.packager.config.forceCodeSigning) await context.packager.sign(binary)
    return
  }
  if (context.electronPlatformName !== 'darwin') return
  const signed = context.packager.config.forceCodeSigning
  let identity = '-'
  const options = []
  if (signed) {
    const { findIdentity } = await import('app-builder-lib/out/codeSign/macCodeSign.js')
    const { keychainFile } = await context.packager.codeSigningInfo.value
    const found = await findIdentity('Developer ID Application', context.packager.platformSpecificBuildOptions.identity, keychainFile)
    if (!found) throw new Error('Connector signing requires Developer ID Application')
    identity = found.hash
    if (keychainFile) options.push('--keychain', keychainFile)
    options.push('--options', 'runtime', '--timestamp', '--entitlements', 'build/entitlements.mac.plist')
  }
  await execute('/usr/bin/codesign', ['--force', '--sign', identity, ...options, binary])
  await execute('/usr/bin/codesign', ['--verify', '--strict', binary])
}

async function notarizeArchive(context, archive) {
  if (context.electronPlatformName !== 'darwin' || !context.packager.config.forceCodeSigning) return
  const env = process.env
  const args = env.APPLE_ID ? ['--apple-id', env.APPLE_ID, '--password', env.APPLE_APP_SPECIFIC_PASSWORD, '--team-id', env.APPLE_TEAM_ID]
    : env.APPLE_API_KEY ? ['--key', env.APPLE_API_KEY, '--key-id', env.APPLE_API_KEY_ID, '--issuer', env.APPLE_API_ISSUER]
      : ['--keychain-profile', env.APPLE_KEYCHAIN_PROFILE]
  try {
    const { stdout } = await execute('/usr/bin/xcrun', ['notarytool', 'submit', archive, ...args, '--wait', '--output-format', 'json'], { timeout: 900000 })
    if (JSON.parse(stdout).status !== 'Accepted') throw new Error('Not accepted')
  } catch { throw new Error('Connector archive notarization failed') }
}

export async function createConnectorBundle(spec, directory, destination, platform, arch) {
  const binary = spec.binary + (platform === 'win32' ? '.exe' : '')
  const files = []
  const contents = {}
  for (const name of (await readdir(directory)).sort()) {
    const bytes = await readFile(join(directory, name))
    contents[name] = [bytes, { mtime: new Date('2026-01-01T00:00:00Z'), os: 3, attrs: ((name === binary ? 0o100755 : 0o100644) << 16) >>> 0 }]
    files.push({ name, bytes: bytes.length, sha256: digest(bytes) })
  }
  if (!contents[binary] || !contents.LICENSE || spec.id === 'dingtalk' && !contents['dws-skills.zip']) throw new Error('Incomplete connector bundle')
  const archive = zipSync(contents, { level: 6 })
  const sha256 = digest(archive)
  const name = `${spec.id}-${spec.version}-${platform}-${arch}-${sha256}.zip`
  await mkdir(destination, { recursive: true })
  await writeFile(join(destination, name), archive)
  return { id: spec.id, version: spec.version, platform, arch, binary, archive: name, sha256, bytes: archive.length, files }
}

/** Only the small trusted manifest enters the app; native components remain release artifacts. */
export async function afterConnectorPack(context) {
  const platform = context.electronPlatformName
  const arch = typeof context.arch === 'string' ? context.arch : ({ 0: 'ia32', 1: 'x64', 3: 'arm64' })[context.arch]
  if (!['x64', 'arm64'].includes(arch)) throw new Error('Unsupported connector architecture')
  const resources = platform === 'darwin' ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents/Resources') : join(context.appOutDir, 'resources')
  const output = join(context.outDir, 'connector-assets')
  const stagingRoot = join(context.outDir, '.connector-build')
  await mkdir(stagingRoot, { recursive: true })
  const staging = await mkdtemp(join(stagingRoot, `${platform}-${arch}-`))
  const components = []
  try {
    for (const spec of specs) {
      const directory = join(staging, spec.id)
      const binary = await spec.prepare(directory, platform, arch)
      if (spec.id === 'dingtalk') await copyFile(join(dirname(require.resolve('dingtalk-workspace-cli/package.json')), 'assets/dws-skills.zip'), join(directory, 'dws-skills.zip'))
      await signBinary(context, binary)
      const component = await createConnectorBundle(spec, directory, output, platform, arch)
      await notarizeArchive(context, join(output, component.archive))
      components.push(component)
    }
    const manifest = JSON.stringify({ schemaVersion: 1, components }, null, 2) + '\n'
    await mkdir(resources, { recursive: true })
    await writeFile(join(resources, 'connector-dependencies.json'), manifest)
    await writeFile(join(output, `${platform}-${arch}.json`), manifest)
  } finally { await rm(staging, { recursive: true, force: true }) }
}
