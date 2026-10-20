import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build as buildRenderer } from 'vite'
import { build as buildPreload } from 'esbuild'
import electron from 'electron'
import { parseOptions } from './common.mjs'

export async function buildRecorder() {
  const root = dirname(fileURLToPath(import.meta.url))
  const output = resolve(root, '../../artifacts/sensevoice/recorder')
  await mkdir(output, { recursive: true })
  await buildRenderer({ configFile: false, root, base: './', logLevel: 'warn', build: {
    outDir: output, emptyOutDir: false, assetsInlineLimit: 0, rollupOptions: {
      input: { recorder: resolve(root, 'recorder.html') },
      output: { entryFileNames: '[name].js' },
    },
  } })
  await buildPreload({ entryPoints: [resolve(root, 'recorder-preload.cjs')], outfile: resolve(output, 'recorder-preload.cjs'),
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
  return output
}

async function main() {
  parseOptions(process.argv.slice(2))
  process.stdout.write('Preparing speech recorder...\n')
  const directory = await buildRecorder()
  const env = { ...process.env, SEP_SPEECH_RECORDER_DIR: directory }
  delete env.ELECTRON_RUN_AS_NODE
  process.stdout.write('Opening speech recorder window...\n')
  const child = spawn(electron, [fileURLToPath(new URL('./recorder-main.mjs', import.meta.url)), ...process.argv.slice(2)], {
    env, stdio: 'inherit', windowsHide: false,
  })
  child.once('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
  child.once('exit', code => { process.exitCode = code ?? 1 })
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
