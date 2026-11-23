import * as assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { assertLocalMediaDiskSpace, LocalMediaRuntime, localMediaInput } from './local-media-runtime'
import { localMediaExecutable, localMediaH264Args, localMediaTarget } from '../domain/local-media-platform'
import { localMediaOperation } from '../domain/local-media-tools'
import type { LocalMediaProgress } from '../../src/shared/local-media-progress'

test('local media only accepts attachment references and the fixed operation parameters', () => {
  assert.ok(!localMediaOperation.safeParse({ operation: 'trim', attachmentId: 'x', start: 0, end: 1, argv: [] }).success)
  assert.ok(!localMediaOperation.safeParse({ operation: 'transcode', attachmentId: 'C:/clip.mp4' }).success)
  assert.ok(localMediaOperation.safeParse({ operation: 'join', attachmentIds: ['a', 'b'] }).success)
  const photo = { kind: 'image', attachmentId: 'photo', duration: 2, motion: 'pan-right' }
  assert.ok(localMediaOperation.safeParse({ operation: 'compose', clips: [photo, { kind: 'video', attachmentId: 'clip' }], aspect: '9:16' }).success)
  for (const input of [
    { clips: [] }, { clips: Array(9).fill(photo) }, { clips: [photo], aspect: '4:3' },
    { clips: [{ ...photo, duration: 0 }] }, { clips: [{ ...photo, duration: 301 }] },
    { clips: [{ ...photo, motion: 'movie=anything' }] }, { clips: [{ ...photo, path: 'C:/photo.png' }] },
    { clips: [{ kind: 'video', attachmentId: 'clip', motion: 'zoom-in' }] },
    { clips: [{ ...photo, rotation: 45 }] }, { clips: [photo], resolution: 2160 },
    { clips: [photo], music: { attachmentId: 'track', volume: 2 } }, { clips: [photo], transitions: ['unknown'] },
  ]) assert.ok(!localMediaOperation.safeParse({ operation: 'compose', ...input }).success)
})

const bin = process.env.SEP_LOCAL_MEDIA_DEV_DIR
const skipNative = !bin || !localMediaTarget(process.platform, process.arch)
const ffmpegName = localMediaExecutable('ffmpeg')

test('local media picks the packaged architecture, executable names and native H.264 encoder', () => {
  assert.equal(localMediaTarget('win32', 'x64'), 'win-x64')
  assert.equal(localMediaTarget('darwin', 'arm64'), 'mac-arm64')
  assert.equal(localMediaTarget('darwin', 'x64'), 'mac-x64')
  assert.equal(localMediaTarget('win32', 'arm64'), undefined)
  assert.equal(localMediaTarget('linux', 'x64'), undefined)
  assert.equal(localMediaExecutable('ffprobe', 'darwin'), 'ffprobe')
  assert.equal(localMediaExecutable('ffprobe', 'win32'), 'ffprobe.exe')
  assert.deepEqual(localMediaH264Args('4M', 'win32'), ['-pix_fmt', 'nv12', '-c:v', 'h264_mf', '-b:v', '4M'])
  assert.deepEqual(localMediaH264Args('8M', 'darwin'), ['-pix_fmt', 'nv12', '-c:v', 'h264_videotoolbox', '-allow_sw', '1', '-bf', '0', '-b:v', '8M'])
})

test('scratch and output volumes get independent space reservations, combined when they share a volume', () => {
  const MiB = 1024 ** 2
  const free = BigInt(45 * MiB)
  const required = 20 * MiB
  assert.doesNotThrow(() => assertLocalMediaDiskSpace(false, free, free, required, required))
  assert.throws(() => assertLocalMediaDiskSpace(true, free, free, required, required), /成果目录空间不足/)
  assert.throws(() => assertLocalMediaDiskSpace(false, 0n, free, required, required), /临时目录空间不足/)
  assert.throws(() => assertLocalMediaDiskSpace(false, free, 0n, required, required), /成果目录空间不足/)
})
test('local media reports missing attachments and incomplete components before approval', async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'csep-media-test-')))
  try {
    const runtime = new LocalMediaRuntime(fixture, async () => assert.fail('scratch should not be needed'))
    const options = {
      resolveAttachment: async () => assert.fail('attachment should not be read'),
      checkArtifact: async () => assert.fail('output should not be prepared'),
      assertActive: (signal?: AbortSignal) => signal?.throwIfAborted(),
      runSignal: new AbortController().signal,
      artifactPath: fixture, artifactRelativePath: 'results',
      authorize: async () => assert.fail('approval should not be requested'),
    }
    const clipPath = join(fixture, 'clip.mp4')
    const empty = runtime.bind({ ...options, attachments: [] })
    assert.deepEqual(await empty.execute({ operation: 'list' }), {
      files: [], message: '请通过输入框的「+」添加图片或音视频附件，或从文件夹预览中选择并导入素材。',
    })
    await assert.rejects(empty.execute({ operation: 'probe', attachmentId: 'clip' }), /添加图片或音视频附件/)

    await writeFile(join(fixture, ffmpegName), '', { mode: 0o755 })
    const withClip = runtime.bind({ ...options, attachments: [{ attachmentId: 'clip', sha256: '0'.repeat(64),
      mediaType: 'application/octet-stream', displayName: 'clip.mp4', readPath: clipPath, byteLength: 42, extractionStatus: 'unsupported' }] })
    assert.deepEqual(await withClip.execute({ operation: 'list' }), {
      files: [{ attachmentId: 'clip', displayName: 'clip.mp4', kind: 'video' }],
      message: '当前客户端的本地音视频组件未就绪，请联系维护人员检查客户端资源。该工具不依赖 Bash 或 Python。',
    })
    await assert.rejects(withClip.execute({ operation: 'probe', attachmentId: 'clip' }), /组件未就绪/)
    await assert.rejects(withClip.execute({ operation: 'trim', attachmentId: 'clip', start: 0, end: 1 }), /组件未就绪/)
    await assert.rejects(withClip.execute({ operation: 'probe', attachmentId: 'other' }), /不属于本会话/)
  } finally { await rm(fixture, { recursive: true, force: true }) }
})

test('native processing probes, trims, joins, extracts and transcodes without Python', { skip: skipNative }, async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'csep-media-test-')))
  try {
    const scratch = join(fixture, '临时 文件')
    const output = join(fixture, '成果 文件')
    const clip = join(fixture, '本地 样例.mp4')
    const wave = join(fixture, '纯 音频.wav')
    await mkdir(scratch)
    await mkdir(output)
    execFileSync(join(bin!, ffmpegName), ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', ...localMediaH264Args('1M'), '-c:a', 'aac', '-shortest', clip])
    execFileSync(join(bin!, ffmpegName), ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', wave])
    const source = await readFile(clip)
    const item = { attachmentId: 'clip', sha256: '0'.repeat(64), mediaType: 'application/octet-stream', displayName: '本地 样例.mp4',
      readPath: clip, byteLength: source.length, extractionStatus: 'not-required' }
    assert.ok(localMediaInput(item))
    const run = new AbortController()
    let approved = false
    let checks = 0
    const runtime = new LocalMediaRuntime(bin!, async () => scratch)
    const host = runtime.bind({ attachments: [item, { ...item, attachmentId: 'wave', displayName: '纯 音频.wav', readPath: wave,
      byteLength: (await readFile(wave)).length }], resolveAttachment: async item => item, checkArtifact: async () => true,
      assertActive: signal => signal?.throwIfAborted(), runSignal: run.signal, artifactPath: output, artifactRelativePath: '成果/fixture',
      authorize: async () => { checks++; return approved } })
    assert.deepEqual(await host.execute({ operation: 'list' }), { files: [{ attachmentId: 'clip', displayName: '本地 样例.mp4', kind: 'video' }, { attachmentId: 'wave', displayName: '纯 音频.wav', kind: 'audio' }] })
    assert.ok(await host.execute({ operation: 'probe', attachmentId: 'clip' }))
    assert.equal(checks, 0)
    await assert.rejects(host.execute({ operation: 'probe', attachmentId: 'foreign' }), /本会话/)
    await assert.rejects(host.execute({ operation: 'transcode', attachmentId: 'clip' }), /未授权/)
    assert.deepEqual(await readdir(output), [])
    approved = true
    for (const request of [{ operation: 'trim', attachmentId: 'clip', start: 0.5, end: 1.5 },
      { operation: 'transcode', attachmentId: 'clip' }, { operation: 'extract_audio', attachmentId: 'clip' },
      { operation: 'join', attachmentIds: ['clip', 'clip'] }, { operation: 'trim', attachmentId: 'wave', start: 0.5, end: 1.5 }]) {
      await assert.doesNotReject(host.execute(request), request.operation)
    }
    assert.equal((await readdir(output)).length, 5)
    assert.deepEqual(await readdir(scratch), [])
    assert.deepEqual(await readFile(clip), source)
    run.abort()
    await assert.rejects(host.execute({ operation: 'probe', attachmentId: 'clip' }))
  } finally { await rm(fixture, { recursive: true, force: true }) }
})

test('native composition orders photos and video, animates photos, and preserves video sound', { skip: skipNative }, async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'csep-media-test-')))
  try {
    const scratch = join(fixture, '合成 临时')
    const output = join(fixture, '合成 成果')
    await mkdir(scratch)
    await mkdir(output)
    const ffmpeg = (...args: string[]) => execFileSync(join(bin!, ffmpegName), ['-v', 'error', '-nostdin', ...args])
    const pngPath = join(fixture, '红色 照片.png')
    const jpgPath = join(fixture, '蓝色 照片.jpg')
    const clipPath = join(fixture, '绿色 视频.mp4')
    const snapshotPath = join(fixture, 'snapshot')
    ffmpeg('-f', 'lavfi', '-i', 'color=red:s=320x180,drawbox=x=118:y=30:w=25:h=120:color=white:t=fill', '-frames:v', '1', '-update', '1', pngPath)
    ffmpeg('-f', 'lavfi', '-i', 'color=blue:s=240x320,drawbox=x=70:y=75:w=40:h=170:color=white:t=fill', '-frames:v', '1', '-update', '1', jpgPath)
    await writeFile(snapshotPath, await readFile(jpgPath))
    ffmpeg('-f', 'lavfi', '-i', 'color=green:s=320x180:r=24:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      ...localMediaH264Args('1M'), '-c:a', 'aac', clipPath)
    const sources = await Promise.all([pngPath, clipPath, snapshotPath].map(readFileWithPath))
    const attachments = sources.map(({ path, bytes }, index) => ({ attachmentId: `asset${index}`, sha256: '0'.repeat(64),
      mediaType: ['image/png', 'video/mp4', 'image/jpeg'][index], displayName: ['红色 照片.png', '绿色 视频.mp4', '蓝色 照片.jpg'][index],
      byteLength: bytes.length, extractionStatus: 'not-required', readPath: path }))
    let approved = false
    const runtime = new LocalMediaRuntime(bin!, async () => scratch)
    const host = runtime.bind({ attachments, resolveAttachment: async item => item, checkArtifact: async () => true,
      assertActive: signal => signal?.throwIfAborted(), runSignal: new AbortController().signal, artifactPath: output, artifactRelativePath: '成果',
      authorize: async input => {
        assert.deepEqual((input as { plan: { clips: Array<{ name: string }> } }).plan.clips.map(item => item.name), attachments.map(item => item.displayName))
        return approved
      } })
    assert.deepEqual((await host.execute({ operation: 'list' }) as { files: Array<{ kind: string }> }).files.map(file => file.kind), ['image', 'video', 'image'])
    assert.equal((await host.execute({ operation: 'probe', attachmentId: 'asset0' }) as { durationSeconds: null }).durationSeconds, null)
    await assert.rejects(host.execute({ operation: 'transcode', attachmentId: 'asset0' }), /图片请使用合成/)
    await assert.rejects(host.execute({ operation: 'compose', clips: [{ kind: 'video', attachmentId: 'asset0' }] }), /片段类型/)
    await assert.rejects(host.execute({ operation: 'compose', clips: [{ kind: 'image', attachmentId: 'foreign', duration: 1 }] }), /本会话/)
    const request = { operation: 'compose', aspect: '9:16', clips: [
      { kind: 'image', attachmentId: 'asset0', duration: 1, motion: 'zoom-in' },
      { kind: 'video', attachmentId: 'asset1' },
      { kind: 'image', attachmentId: 'asset2', duration: 1.4, motion: 'pan-right' },
    ] }
    await assert.rejects(host.execute(request), /未授权/)
    assert.deepEqual(await readdir(output), [])
    approved = true
    const result = await host.execute(request) as { file: string; durationSeconds: number; bytes: number }
    assert.ok(Math.abs(result.durationSeconds - 3.4) < 0.05)
    const [name] = await readdir(output)
    assert.equal(result.file, `成果/${name}`)
    const resultPath = join(output, name)
    const frame = (time: string) => ffmpeg('-ss', time, '-i', resultPath, '-vf', 'scale=32:56', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1')
    for (const [t, color] of [['0.4', 0], ['1.5', 1], ['2.5', 2]] as const) {
      const picture = frame(t)
      const pixel = (28 * 32 + 16) * 3
      assert.ok(picture[pixel + color] > picture[pixel + (color + 1) % 3] + 40,
        `frame ${t}: RGB=${[...picture.subarray(pixel, pixel + 3)]}, bytes=${picture.length}`)
    }
    // Look for actual movement of the white shape, rather than compression noise between frames.
    const bright = (picture: Buffer) => Array.from({ length: picture.length / 3 }, (_, i) => picture[i * 3] > 190 && picture[i * 3 + 1] > 190 && picture[i * 3 + 2] > 190)
    const changed = (a: string, b: string) => {
      const earlier = bright(frame(a))
      return bright(frame(b)).filter((pixel, i) => earlier[i] !== pixel).length
    }
    assert.ok(changed('0.1', '0.9') > 20, 'photo zooms toward the center')
    assert.ok(changed('2.1', '3.2') > 20, 'photo pans across the frame')
    const audio = (time: string) => ffmpeg('-ss', time, '-i', resultPath, '-t', '0.25', '-vn', '-f', 's16le', 'pipe:1')
    assert.ok(audio('0.25').every(byte => byte === 0), 'photo segment is silent')
    assert.ok(audio('1.25').some(byte => byte !== 0), 'video segment retains sound')
    assert.ok(audio('2.25').every(byte => byte === 0), 'trailing photo segment is silent')
    assert.deepEqual(await readdir(scratch), [])
    for (const { path, bytes } of sources) assert.deepEqual(await readFile(path), bytes)
  } finally { await rm(fixture, { recursive: true, force: true }) }
})

async function readFileWithPath(path: string): Promise<{ path: string; bytes: Buffer }> {
  return { path, bytes: await readFile(path) }
}

test('native phase-one edit trims repeated video ranges, mixes music and renders verified 1080p transitions', { skip: skipNative }, async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'csep-media-test-')))
  try {
    const scratch = join(fixture, '临时 文件')
    const output = join(fixture, '成果 文件')
    await mkdir(scratch)
    await mkdir(output)
    const ffmpeg = (...args: string[]) => execFileSync(join(bin!, ffmpegName), ['-v', 'error', '-nostdin', ...args])
    const photo = join(fixture, '蓝色 图.png')
    const clip = join(fixture, '分段 视频.mp4')
    const music = join(fixture, '配乐.wav')
    ffmpeg('-f', 'lavfi', '-i', 'color=blue:s=320x180', '-frames:v', '1', '-update', '1', photo)
    ffmpeg('-f', 'lavfi', '-i', "color=green:s=320x180:r=24:d=3,drawbox=c=yellow:t=fill:enable='between(t,1,2)'",
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.9', ...localMediaH264Args('1M'), '-c:a', 'aac', clip)
    ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=880:duration=3', music)
    const sources = await Promise.all([photo, clip, music].map(readFileWithPath))
    const inputs = sources.map(({ path, bytes }, i) => ({ attachmentId: `asset${i}`, sha256: '0'.repeat(64),
      mediaType: ['image/png', 'video/mp4', 'audio/wav'][i], displayName: path.slice(fixture.length + 1), readPath: path,
      byteLength: bytes.length, extractionStatus: 'not-required' }))
    const authorization: unknown[] = []
    let approved = false
    let scratchCalls = 0
    const runtime = new LocalMediaRuntime(bin!, async () => { scratchCalls++; return scratch })
    const abort = new AbortController()
    const host = runtime.bind({ attachments: inputs, resolveAttachment: async item => item, checkArtifact: async () => true,
      assertActive: signal => signal?.throwIfAborted(), runSignal: abort.signal, artifactPath: output, artifactRelativePath: '成果',
      authorize: async input => { authorization.push(input); return approved } })
    const request = { operation: 'compose', aspect: '9:16', resolution: 1080,
      transitions: [0.2, 'cut', 0.2], fadeIn: 0.2, fadeOut: 0.2, music: { attachmentId: 'asset2', volume: 0.4 }, clips: [
        { kind: 'image', attachmentId: 'asset0', duration: 0.8, fit: 'crop' },
        { kind: 'video', attachmentId: 'asset1', start: 0.25, end: 0.85, rotation: 90 },
        { kind: 'video', attachmentId: 'asset1', start: 2.25, end: 2.85, volume: 0 },
        { kind: 'image', attachmentId: 'asset0', duration: 0.8, fit: 'crop' },
      ] }
    const planned = await host.execute({ ...request, dryRun: true }) as { plan: { durationSeconds: number } }
    assert.equal(planned.plan.durationSeconds, 2.4)
    assert.equal(authorization.length, 0)
    await assert.rejects(host.execute({ ...request, transitions: [0.2] }), /转场数量/)
    await assert.rejects(host.execute({ ...request, transitions: [0.8, 'cut', 0.2] }), /片段太短/)
    await assert.rejects(host.execute({ ...request, music: { attachmentId: 'asset0' } }), /音频附件/)
    await assert.rejects(host.execute({ ...request, clips: [{ kind: 'video', attachmentId: 'asset1', start: 9 }], transitions: [] }), /裁剪范围/)
    await assert.rejects(host.execute(request), /未授权/)
    assert.equal(scratchCalls, 0)
    assert.deepEqual(await readdir(output), [])
    approved = true
    const progress: LocalMediaProgress[] = []
    const result = await host.execute(request, undefined, update => progress.push(update)) as { durationSeconds: number }
    assert.ok(Math.abs(result.durationSeconds - 2.4) < 0.04)
    assert.deepEqual((authorization.at(-1) as { plan: unknown }).plan, planned.plan)
    assert.deepEqual([...new Set(progress.map(update => update.phase))], ['probe', 'render', 'verify', 'save'])
    assert.ok(progress.some(update => update.phase === 'render' && update.percent !== undefined && update.percent <= 99))
    const resultPath = join(output, (await readdir(output))[0])
    const sample = (t: string, x = 8, y = 14) => {
      const rgb = ffmpeg('-ss', t, '-i', resultPath, '-vf', 'scale=16:28', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1')
      return [...rgb.subarray((y * 16 + x) * 3, (y * 16 + x) * 3 + 3)]
    }
    const firstPixel = sample('0')
    assert.ok(firstPixel.every(value => value < 12), `fade in starts at black: RGB=${firstPixel}`)
    assert.ok(sample('0.35')[2] > 150, 'first photo fills canvas')
    const blend = sample('0.7')
    assert.ok(blend[1] > 30 && blend[2] > 50, 'transition blends both inputs')
    assert.ok(sample('1', 8, 2)[1] > 70, 'rotated video fills the portrait frame')
    assert.ok(sample('1.45', 8, 2).every(value => value < 12), 'unrotated video retains the padding')
    assert.ok(sample('1.45')[0] < 40 && sample('1.45')[1] > 70, 'middle yellow section was removed')
    assert.ok(sample('2.36').every(value => value < 20), 'fade out ends at black')
    const tone = (t: string, hz: number) => {
      const pcm = ffmpeg('-ss', t, '-i', resultPath, '-t', '0.1', '-vn', '-ar', '48000', '-ac', '1', '-f', 's16le', 'pipe:1')
      let real = 0, imag = 0
      for (let i = 0; i < pcm.length / 2; i++) {
        const phase = i * Math.PI * 2 * hz / 48000
        const v = pcm.readInt16LE(i * 2)
        real += v * Math.cos(phase)
        imag += v * Math.sin(phase)
      }
      return Math.hypot(real, imag) / (pcm.length / 2)
    }
    assert.ok(tone('0.9', 440) > 600 && tone('0.9', 880) > 200, 'both original and music tones are present')
    assert.ok(tone('1.35', 440) < 50 && tone('1.35', 880) > 200, 'muting original keeps the music')
    const saved = await readdir(output)
    const cancelled = new AbortController()
    await assert.rejects(host.execute(request, cancelled.signal, update => {
      if (update.phase === 'render' && update.percent !== undefined) cancelled.abort()
    }), /已取消/)
    assert.deepEqual(await readdir(output), saved)
    assert.deepEqual(await readdir(scratch), [])
    for (const source of sources) assert.deepEqual(await readFile(source.path), source.bytes)
  } finally { await rm(fixture, { recursive: true, force: true }) }
})
