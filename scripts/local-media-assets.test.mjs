import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { afterLocalMediaPack, beforeLocalMediaPack } from './local-media-assets.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')

for (const [platform, arch, target] of [['win32', 1, 'win-x64'], ['darwin', 1, 'mac-x64'], ['darwin', 3, 'mac-arm64']]) {
  test(`${target} packages the verified binaries, exact source and license`, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'csep-ffmpeg-package-')))
    t.after(() => rm(root, { recursive: true, force: true }))
    const isMac = platform === 'darwin'
    const context = { electronPlatformName: platform, arch, appOutDir: join(root, 'out'), packager: { projectDir: root, appInfo: { productFilename: '元机AI' } } }
    const dir = join(root, 'resources', 'local-media', target)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '..', 'source.json'), JSON.stringify({ version: 'test', sha256: hash('source') }))
    await assert.rejects(beforeLocalMediaPack(context), /Prepare the pinned/)
    const [ffmpeg, ffprobe] = isMac ? ['ffmpeg', 'ffprobe'] : ['ffmpeg.exe', 'ffprobe.exe']
    const config = `${isMac ? '--enable-videotoolbox' : '--enable-mediafoundation'} --disable-network`
    const files = { [ffmpeg]: target, [ffprobe]: 'probe', 'ffmpeg-test.tar.xz': 'source', 'COPYING.LGPLv2.1': 'license',
      [isMac ? 'build-local-media-mac.sh' : 'build-local-media-win.sh']: 'recipe', 'build-config.txt': config,
      SHA256SUMS: `${hash(target)}  ${ffmpeg}\n${hash('probe')}  ${ffprobe}\n` }
    for (const [file, contents] of Object.entries(files)) await writeFile(join(dir, file), contents)
    await beforeLocalMediaPack(context)
    await writeFile(join(dir, 'SHA256SUMS'), `${hash(target)} *${ffmpeg}\r\n${hash('probe')} *${ffprobe}\r\n`)
    await beforeLocalMediaPack(context)
    await afterLocalMediaPack(context)
    const resources = isMac ? join(context.appOutDir, '元机AI.app', 'Contents', 'Resources') : join(context.appOutDir, 'resources')
    const out = join(resources, 'local-media')
    assert.deepEqual((await readdir(out)).sort(), Object.keys(files).filter(name => !isMac || name !== 'SHA256SUMS').sort())
    assert.equal(await readFile(join(out, ffmpeg), 'utf8'), target)
    assert.equal(await readFile(join(out, 'ffmpeg-test.tar.xz'), 'utf8'), 'source')
    if (isMac && process.platform !== 'win32') assert.equal((await stat(join(out, ffmpeg))).mode & 0o777, 0o755)
    await writeFile(join(dir, 'build-config.txt'), `${config} --enable-gpl`)
    await assert.rejects(beforeLocalMediaPack(context), error => error.cause?.message === 'Unexpected FFmpeg build configuration')
    await writeFile(join(dir, 'build-config.txt'), config)
    await writeFile(join(dir, ffprobe), 'wrong binary')
    await assert.rejects(beforeLocalMediaPack(context), error => error.cause?.message === `FFmpeg checksum mismatch: ${ffprobe}`)
  })
}

test('unsupported platforms do not attempt to stage local media resources', async () => {
  for (const [electronPlatformName, arch] of [['win32', 3], ['darwin', 4], ['linux', 1]]) {
    const context = { electronPlatformName, arch, get packager() { throw new Error('must not resolve resources') } }
    await beforeLocalMediaPack(context)
    await afterLocalMediaPack(context)
  }
})

test('macOS app signing skips the corresponding source archive, not the Mach-O tools', async () => {
  const { build } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const ignored = name => build.mac.signIgnore.some(pattern => new RegExp(pattern).test(`/App.app/Contents/Resources/local-media/${name}`))
  assert.ok(ignored('ffmpeg-8.1.2.tar.xz'))
  assert.ok(!ignored('ffmpeg') && !ignored('ffprobe'))
})

test('Windows Media Foundation enables its D3D11 dependency with autodetection disabled', async () => {
  const script = await readFile(new URL('./build-local-media-win.sh', import.meta.url), 'utf8')
  assert.match(script, /--disable-autodetect/)
  assert.match(script, /--enable-mediafoundation/)
  assert.match(script, /--enable-d3d11va/)
})

test('native media builds retain PNG support when autodetection is disabled', async () => {
  for (const platform of ['mac', 'win']) {
    const script = await readFile(new URL(`./build-local-media-${platform}.sh`, import.meta.url), 'utf8')
    assert.match(script, /--enable-zlib/)
    assert.match(script, /-c:v png/)
  }
})
