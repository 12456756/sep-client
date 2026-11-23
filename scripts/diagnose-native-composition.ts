import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { compositionFilters, resolveComposition } from '../electron/runtime/local-media-composition'

const executable = join(resolve(process.argv[2]), 'ffmpeg')
const directory = mkdtempSync(join(tmpdir(), 'sep-native-composition-'))
const run = (args: string[]) => execFileSync(executable, ['-v', 'error', '-nostdin', ...args], { maxBuffer: 20 * 1024 * 1024 })
try {
  const photo = join(directory, 'photo.png')
  const video = join(directory, 'video.mp4')
  run(['-f', 'lavfi', '-i', 'color=blue:s=320x180', '-frames:v', '1', '-update', '1', photo])
  run(['-f', 'lavfi', '-i', 'color=green:s=320x180:r=30:d=1', '-pix_fmt', 'nv12', '-c:v', 'h264_videotoolbox', '-allow_sw', '1', '-bf', '0', '-b:v', '1M', video])
  const plan = resolveComposition({ operation: 'compose', aspect: '9:16', fadeIn: 0.2, clips: [
    { kind: 'image', attachmentId: 'a', duration: 1 }, { kind: 'video', attachmentId: 'b' },
  ] }, [{ name: 'photo', video: { index: 0, width: 320, height: 180 } }, { name: 'video', video: { index: 0, width: 320, height: 180, duration: 1 } }])
  for (const threads of ['1', '2']) {
    for (const format of ['nv12', 'yuv420p']) {
      const filters = compositionFilters(plan).replace('format=nv12[vout]', `format=${format}[vout]`)
      const base = ['-threads', '2', '-i', photo, '-threads', '2', '-i', video, '-filter_complex_threads', threads,
        '-filter_complex', filters, '-map', '[vout]', '-map', '[aout]']
      const file = join(directory, `${threads}-${format}.mp4`)
      run([...base, '-r', '30', '-pix_fmt', format, '-c:v', 'h264_videotoolbox', '-allow_sw', '1', '-bf', '0', '-b:v', '4M', '-c:a', 'aac', file])
      for (const time of ['0', '0.4', '1.5']) {
        const rgb = run(['-ss', time, '-i', file, '-vf', 'scale=16:28', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'])
        console.log(JSON.stringify({ threads, format, time, rgb: [...rgb.subarray((14 * 16 + 8) * 3, (14 * 16 + 8) * 3 + 3)] }))
      }
    }
  }
} finally { rmSync(directory, { recursive: true, force: true }) }
