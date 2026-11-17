import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir, copyFile, chmod, mkdtemp, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { unzipSync } from 'fflate'
import { prepareDevelopmentAssets } from './dev-assets-cache.mjs'

const require = createRequire(import.meta.url)
const packageRoot = dirname(require.resolve('@larksuite/cli/package.json'))
export async function prepareFeishu(directory, platform = process.platform, arch = process.arch, sourceRoot = packageRoot, download = fetch) {
  const { version } = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'))
  if (version !== '1.0.100') throw new Error('Unexpected Feishu runtime version.')
  const os = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[platform]
  const cpu = { x64: 'amd64', arm64: 'arm64' }[arch]
  if (!os || !cpu) throw new Error(`Unsupported Feishu runtime: ${platform}/${arch}`)
  const name = `lark-cli-${version}-${os}-${cpu}.${os === 'windows' ? 'zip' : 'tar.gz'}`
  const sums = await readFile(join(sourceRoot, 'checksums.txt'), 'utf8')
  const expected = sums.split(/\r?\n/).find(line => line.trim().endsWith(`  ${name}`))?.trim().split(/\s+/)[0]
  if (!/^[a-f0-9]{64}$/i.test(expected ?? '')) throw new Error('Feishu archive checksum missing.')
  const cache = join(sourceRoot, 'assets')
  await mkdir(cache, { recursive: true })
  const archive = join(cache, name)
  let bytes = await readFile(archive).catch(() => undefined)
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== expected) {
    const urls = [
      `https://github.com/larksuite/cli/releases/download/v${version}/${name}`,
      `https://registry.npmmirror.com/-/binary/lark-cli/v${version}/${name}`,
    ]
    bytes = undefined
    for (const url of urls) {
      try {
        const response = await download(url, { signal: AbortSignal.timeout(120000) })
        if (!response.ok) continue
        const downloaded = Buffer.from(await response.arrayBuffer())
        if (createHash('sha256').update(downloaded).digest('hex') !== expected) continue
        bytes = downloaded
        await writeFile(archive, bytes)
        break
      } catch { /* Try the official installer's mirror; checksum remains authoritative. */ }
    }
    if (!bytes) throw new Error('Cannot download verified Feishu runtime.')
  }
  await mkdir(directory, { recursive: true })
  const binary = platform === 'win32' ? 'lark-cli.exe' : 'lark-cli'
  const target = join(directory, binary)
  if (platform === 'win32') {
    const executable = unzipSync(bytes)[binary]
    if (!executable) throw new Error('Feishu executable missing.')
    await writeFile(target, executable)
  } else {
    const temporary = await mkdtemp(join(cache, 'extract-'))
    try { execFileSync('tar', ['-xzf', archive, '-C', temporary], { windowsHide: true }); await copyFile(join(temporary, binary), target) }
    finally { await rm(temporary, { recursive: true, force: true }) }
    await chmod(target, 0o755)
  }
  await copyFile(join(sourceRoot, 'LICENSE'), join(directory, 'LICENSE'))
  return target
}
export async function afterFeishuPack(context) {
  const arch = typeof context.arch === 'string' ? context.arch : ({ 0: 'ia32', 1: 'x64', 3: 'arm64' })[context.arch]
  const resources = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources')
  await prepareFeishu(join(resources, 'feishu'), context.electronPlatformName, arch)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = join(packageRoot, 'bin')
  const { version } = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  const os = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[process.platform]
  const cpu = { x64: 'amd64', arm64: 'arm64' }[process.arch]
  await prepareDevelopmentAssets({ directory,
    sources: ['package.json', 'checksums.txt', 'LICENSE', `assets/lark-cli-${version}-${os}-${cpu}.${os === 'windows' ? 'zip' : 'tar.gz'}`].map(path => join(packageRoot, path)),
    outputs: [process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli', 'LICENSE'],
    prepare: () => prepareFeishu(directory),
  })
}
