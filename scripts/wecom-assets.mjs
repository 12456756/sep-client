import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir, copyFile, chmod, mkdtemp, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { prepareDevelopmentAssets } from './dev-assets-cache.mjs'

const require = createRequire(import.meta.url)
const packageRoot = dirname(require.resolve('@wecom/cli/package.json'))
const pinned = JSON.parse(await readFile(fileURLToPath(new URL('../resources/wecom/manifest.json', import.meta.url)), 'utf8'))
export async function prepareWecom(directory, platform = process.platform, arch = process.arch, sourceRoot = packageRoot, download = fetch, manifest = pinned) {
  const key = `${platform}-${arch}`
  const integrity = manifest.integrities[key]
  if (!integrity || !/^sha512-[A-Za-z0-9+/]+=*$/.test(integrity)) throw new Error(`Unsupported WeCom runtime: ${key}`)
  const { version } = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'))
  if (version !== pinned.version || manifest.version !== pinned.version) throw new Error('Unexpected WeCom runtime version.')
  const cache = join(sourceRoot, 'assets')
  await mkdir(cache, { recursive: true })
  const name = `cli-${key}-${version}.tgz`
  const archive = join(cache, name)
  const valid = bytes => bytes && `sha512-${createHash('sha512').update(bytes).digest('base64')}` === integrity
  let bytes = await readFile(archive).catch(() => undefined)
  if (!valid(bytes)) {
    const response = await download(`https://registry.npmjs.org/@wecom/cli-${key}/-/${name}`, { signal: AbortSignal.timeout(120000), redirect: 'error' })
    if (!response.ok) throw new Error('Cannot download WeCom runtime.')
    bytes = Buffer.from(await response.arrayBuffer())
    if (!valid(bytes)) throw new Error('WeCom archive checksum mismatch.')
    await writeFile(archive, bytes)
  }
  const binary = platform === 'win32' ? 'wecom-cli.exe' : 'wecom-cli'
  const temporary = await mkdtemp(join(cache, 'extract-'))
  try {
    execFileSync('tar', ['-xzf', archive, '-C', temporary, `package/bin/${binary}`], { windowsHide: true })
    await mkdir(directory, { recursive: true })
    await copyFile(join(temporary, 'package', 'bin', binary), join(directory, binary))
    if (platform !== 'win32') await chmod(join(directory, binary), 0o755)
    await copyFile(join(sourceRoot, 'LICENSE'), join(directory, 'LICENSE'))
  } finally { await rm(temporary, { recursive: true, force: true }) }
  return join(directory, binary)
}
export async function afterWecomPack(context) {
  const arch = typeof context.arch === 'string' ? context.arch : ({ 0: 'ia32', 1: 'x64', 3: 'arm64' })[context.arch]
  const resources = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources')
  await prepareWecom(join(resources, 'wecom'), context.electronPlatformName, arch)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = join(packageRoot, 'bin')
  await prepareDevelopmentAssets({ directory,
    sources: [join(packageRoot, 'package.json'), join(packageRoot, 'LICENSE'),
      join(packageRoot, 'assets', `cli-${process.platform}-${process.arch}-${pinned.version}.tgz`),
      fileURLToPath(new URL('../resources/wecom/manifest.json', import.meta.url))],
    outputs: [process.platform === 'win32' ? 'wecom-cli.exe' : 'wecom-cli', 'LICENSE'],
    prepare: () => prepareWecom(directory),
  })
}
