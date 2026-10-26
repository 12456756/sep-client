import { createHash } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const officeManifest = JSON.parse(await readFile(join(project, 'resources/office/manifest.json'), 'utf8'))
const skillSha256 = 'a41eb86a29609f21c4bc8b4d8bb8d1135d5af246d6ebbcb23ec917c61708bc76'
const licenses = ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.txt']

export async function verifyOfficeAssets(root, platform, arch) {
  const asset = officeManifest.assets[`${platform}-${arch}`]
  if (!asset) throw new Error(`OfficeCLI is not bundled for ${platform}/${arch}`)
  const executable = join(root, 'office', asset.file)
  const stat = await lstat(executable)
  const bytes = await readFile(executable)
  if (!stat.isFile() || stat.isSymbolicLink() || bytes.length !== asset.size
    || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('OfficeCLI checksum mismatch')
  const skill = await readFile(join(root, 'common-skills/officecli/SKILL.md'))
  if (createHash('sha256').update(skill).digest('hex') !== skillSha256) throw new Error('Office skill checksum mismatch')
  for (const name of licenses) if (!(await readFile(join(root, 'office', name))).length) throw new Error(`Missing Office license: ${name}`)
  if (platform !== 'win32' && !(stat.mode & 0o111)) throw new Error('OfficeCLI is not executable')
  return asset
}

async function fetchBytes(url) {
  let last
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000), headers: { 'User-Agent': 'sep-client-office-assets' } })
      if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`)
      return Buffer.from(await response.arrayBuffer())
    } catch (error) { last = error }
  }
  throw last
}

export async function prepareOfficeAssets(platform = process.platform, arch = process.arch, root = project) {
  const asset = officeManifest.assets[`${platform}-${arch}`]
  if (!asset) throw new Error(`Unsupported OfficeCLI target: ${platform}/${arch}`)
  const directory = join(root, 'resources/office')
  await mkdir(directory, { recursive: true })
  const target = join(directory, asset.file)
  let bytes
  try { bytes = await readFile(target) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!bytes || bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
    bytes = await fetchBytes(`${officeManifest.repository}/releases/download/v${officeManifest.version}/${asset.file}`)
    if (bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('Downloaded OfficeCLI checksum mismatch')
    const temporary = target + '.download'
    try { await writeFile(temporary, bytes); await rename(temporary, target) }
    finally { await rm(temporary, { force: true }) }
  }
  if (platform !== 'win32') await chmod(target, 0o755)
  for (const name of licenses) {
    try { if ((await readFile(join(directory, name))).length) continue } catch (error) { if (error.code !== 'ENOENT') throw error }
    const response = JSON.parse((await fetchBytes(`https://api.github.com/repos/iOfficeAI/OfficeCLI/contents/${name}?ref=v${officeManifest.version}`)).toString('utf8'))
    if (response.encoding !== 'base64' || !response.content) throw new Error(`Invalid license download: ${name}`)
    await writeFile(join(directory, name), Buffer.from(response.content, 'base64'))
  }
  await verifyOfficeAssets(join(root, 'resources'), platform, arch)
  return target
}

export async function beforeOfficePack(context) {
  const arch = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64' }[context.arch]
  await verifyOfficeAssets(join(context.packager.projectDir, 'resources'), context.electronPlatformName, arch)
}

function packagedResources(context) {
  return context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources')
}

// mac.signIgnore preserves the pinned upstream Developer ID signature. Verify the
// final bytes as well, so a signing-policy change cannot ship an unusable tool.
export async function afterOfficeSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const arch = { 1: 'x64', 3: 'arm64' }[context.arch]
  await verifyOfficeAssets(packagedResources(context), 'darwin', arch)
}

export async function afterOfficePack(context) {
  const platform = context.electronPlatformName
  const arch = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64' }[context.arch]
  const source = join(context.packager.projectDir, 'resources')
  const asset = await verifyOfficeAssets(source, platform, arch)
  const resources = packagedResources(context)
  await mkdir(join(resources, 'office'), { recursive: true })
  // Copy after extraResources transformations: Windows must not re-sign this pinned
  // third-party executable and invalidate the checksum enforced by the runtime.
  await copyFile(join(source, 'office', asset.file), join(resources, 'office', asset.file))
  if (platform !== 'win32') await chmod(join(resources, 'office', asset.file), 0o755)
  await verifyOfficeAssets(resources, platform, arch)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [platform = process.platform, arch = process.arch] = process.argv.slice(2)
  try { console.log(`Prepared pinned OfficeCLI: ${await prepareOfficeAssets(platform, arch)}`) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
