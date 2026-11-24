import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const executable = join(resolve(process.argv[2]), 'ffmpeg')
const directory = mkdtempSync(join(tmpdir(), 'sep-native-pixels-'))
const run = args => execFileSync(executable, ['-v', 'error', '-nostdin', ...args])
try {
  for (const format of ['nv12', 'yuv420p']) {
    for (const disableCpu of [false, true]) {
      const cpu = disableCpu ? ['-cpuflags', '0'] : []
      const file = join(directory, `${format}-${disableCpu}.mp4`)
      run([...cpu, '-f', 'lavfi', '-i', 'color=black:s=320x180:d=1', '-pix_fmt', format,
        '-c:v', 'h264_videotoolbox', '-allow_sw', '1', '-bf', '0', '-b:v', '1M', file])
      for (const decodeCpu of [[], ['-cpuflags', '0']]) {
        const rgb = run([...decodeCpu, '-i', file, '-vf', 'scale=16:16', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'])
        const yuv = run([...decodeCpu, '-i', file, '-frames:v', '1', '-pix_fmt', 'yuv420p', '-f', 'rawvideo', 'pipe:1'])
        console.log(JSON.stringify({format, disableCpu, decodeCpu, rgb:[...rgb.subarray(0,3)], yuv:[yuv[0], yuv[320*180], yuv[320*180*5/4]]}))
      }
    }
  }
} finally { rmSync(directory, { recursive: true, force: true }) }
