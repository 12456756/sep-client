import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, mkdir, writeFile, chmod, mkdtemp, rm, copyFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { unzipSync } from 'fflate'
import { pathToFileURL } from 'node:url'
import { prepareDevelopmentAssets } from './dev-assets-cache.mjs'

const require = createRequire(import.meta.url)
const packageRoot = dirname(require.resolve('dingtalk-workspace-cli/package.json'))
const archives = {
  'win32-x64': 'dws-windows-amd64.zip', 'win32-arm64': 'dws-windows-arm64.zip',
  'darwin-x64': 'dws-darwin-amd64.tar.gz', 'darwin-arm64': 'dws-darwin-arm64.tar.gz',
  'linux-x64': 'dws-linux-amd64.tar.gz', 'linux-arm64': 'dws-linux-arm64.tar.gz',
}
export async function prepareDingTalk(directory, platform = process.platform, arch = process.arch) {
  const name = archives[`${platform}-${arch}`]
  if (!name) throw new Error(`Unsupported DingTalk runtime: ${platform}/${arch}`)
  const asset = join(packageRoot, 'assets', name)
  const bytes = await readFile(asset)
  const sums = await readFile(join(packageRoot, 'assets/checksums.txt'), 'utf8')
  const expected = sums.split(/\r?\n/).find(line => line.trim().endsWith(name))?.trim().split(/\s+/)[0]
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('DingTalk runtime checksum mismatch.')
  await mkdir(directory, { recursive: true })
  const skillBytes = await readFile(join(packageRoot, 'assets', 'dws-skills.zip'))
  const skillHash = sums.split(/\r?\n/).find(line => line.trim().endsWith('dws-skills.zip'))?.trim().split(/\s+/)[0]
  if (createHash('sha256').update(skillBytes).digest('hex') !== skillHash) throw new Error('DingTalk skills checksum mismatch.')
  const notices = unzipSync(skillBytes, { filter: entry => ['LICENSE', 'NOTICE'].includes(entry.name) })
  for (const name of ['LICENSE', 'NOTICE']) {
    if (!notices[name]) throw new Error('DingTalk license notice missing.')
    await writeFile(join(directory, name), notices[name])
  }
  const target = join(directory, platform === 'win32' ? 'dws.exe' : 'dws')
  if (platform === 'win32') {
    const files = unzipSync(bytes)
    const executable = Object.entries(files).find(([path]) => /(?:^|\/)dws\.exe$/.test(path))?.[1]
    if (!executable) throw new Error('DingTalk executable missing.')
    await writeFile(target, executable)
  } else {
    const temporary = await mkdtemp(join(directory, 'extract-'))
    try {
      execFileSync('tar', ['-xzf', asset, '-C', temporary], { windowsHide: true })
      await copyFile(join(temporary, 'dws'), target)
    } finally { await rm(temporary, { recursive: true, force: true }) }
    await chmod(target, 0o755)
  }
  return target
}
export async function afterDingTalkPack(context) {
  const arch = typeof context.arch === 'string' ? context.arch : ({ 0: 'ia32', 1: 'x64', 3: 'arm64' })[context.arch]
  const resources = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources')
  const directory = join(resources, 'dingtalk')
  await prepareDingTalk(directory, context.electronPlatformName, arch)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = join(packageRoot, 'vendor')
  await prepareDevelopmentAssets({ directory,
    sources: ['package.json', 'assets/checksums.txt', 'assets/dws-skills.zip', `assets/${archives[`${process.platform}-${process.arch}`]}`].map(path => join(packageRoot, path)),
    outputs: [process.platform === 'win32' ? 'dws.exe' : 'dws', 'LICENSE', 'NOTICE'],
    prepare: () => prepareDingTalk(directory),
  })
}
