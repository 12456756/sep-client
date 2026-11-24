import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'

const windows = { recipe: 'build-local-media-win.sh', configFlag: '--enable-mediafoundation', binaries: ['ffmpeg.exe', 'ffprobe.exe'] }
const mac = { recipe: 'build-local-media-mac.sh', configFlag: '--enable-videotoolbox', binaries: ['ffmpeg', 'ffprobe'] }

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function verifyLocalMedia(directory, spec, target) {
  const { recipe, configFlag, binaries } = target
  const source = `ffmpeg-${spec.version}.tar.xz`
  const lame = `lame-${spec.lame.version}.tar.gz`
  const filenames = [...binaries, source, lame, 'COPYING.LGPLv2.1', 'COPYING.LAME', 'source.json',
    recipe, 'build-local-media-lame.sh', 'build-config.txt', 'SHA256SUMS']
  for (const filename of filenames) {
    const info = await lstat(join(directory, filename))
    if (!info.isFile() || !info.size) throw new Error(`Invalid FFmpeg resource: ${filename}`)
  }
  const config = await readFile(join(directory, 'build-config.txt'), 'utf8')
  const flags = config.split(/\s+/)
  if (!flags.includes(configFlag) || !flags.includes('--disable-network') || !flags.includes('--enable-libmp3lame') || /--enable-(gpl|nonfree|version3)\b/.test(config)) {
    throw new Error('Unexpected FFmpeg build configuration')
  }
  const checksums = (await readFile(join(directory, 'SHA256SUMS'), 'utf8')).trim().split(/\r?\n/)
  for (const filename of binaries) {
    if (!checksums.includes(`${await sha256(join(directory, filename))}  ${filename}`)) throw new Error(`FFmpeg checksum mismatch: ${filename}`)
  }
  if (await sha256(join(directory, source)) !== spec.sha256) throw new Error('FFmpeg corresponding source checksum mismatch')
  if (await sha256(join(directory, lame)) !== spec.lame.sha256) throw new Error('LAME corresponding source checksum mismatch')
  return filenames
}

async function localMediaSource(context) {
  const isMac = context.electronPlatformName === 'darwin'
  const arch = { 1: 'x64', 3: 'arm64' }[context.arch]
  if (!arch || (!isMac && (context.electronPlatformName !== 'win32' || arch !== 'x64'))) return null
  const target = isMac ? mac : windows
  const resource = join(context.packager.projectDir, 'resources', 'local-media')
  const directory = join(resource, `${isMac ? 'mac' : 'win'}-${arch}`)
  const spec = JSON.parse(await readFile(join(resource, 'source.json'), 'utf8'))
  try { return { directory, spec, target, filenames: await verifyLocalMedia(directory, spec, target) } }
  catch (cause) { throw new Error(`Prepare the pinned FFmpeg resources with scripts/${target.recipe}${isMac ? ` ${arch}` : ''} before packaging.`, { cause }) }
}

export async function beforeLocalMediaPack(context) { await localMediaSource(context) }

export async function afterLocalMediaPack(context) {
  const source = await localMediaSource(context)
  if (!source) return
  const isMac = context.electronPlatformName === 'darwin'
  const resources = isMac ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources')
  const destination = join(resources, 'local-media')
  await mkdir(destination, { recursive: true })
  for (const filename of source.filenames) await copyFile(join(source.directory, filename), join(destination, filename))
  await verifyLocalMedia(destination, source.spec, source.target)
  if (isMac) {
    for (const tool of source.target.binaries) await chmod(join(destination, tool), 0o755)
    // Signing changes the Mach-O bytes. The checksums apply to the build inputs only.
    await unlink(join(destination, 'SHA256SUMS'))
  }
}
