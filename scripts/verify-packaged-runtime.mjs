import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractFile, listPackage } from '@electron/asar'

const require = createRequire(import.meta.url)
const provider = '@earendil-works/pi-ai'
const providerModule = `${provider}/api/openai-completions`
const expectedVersion = '0.83.0'

// Resolve from the task worker inside ASAR, never from this repository's node_modules.
const probe = `
import assert from 'node:assert/strict'
import { isAbsolute, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const [archive, parent, specifier] = process.argv.slice(1)
assert.ok(process.versions.electron, 'The packaged runtime probe must run under Electron')
const url = import.meta.resolve(specifier, pathToFileURL(parent).href)
const location = relative(archive, fileURLToPath(url))
assert.ok(!isAbsolute(location) && !location.startsWith('..'), 'Provider resolved outside app.asar: ' + url)
const { streamSimple } = await import(url)
assert.equal(typeof streamSimple, 'function', 'Missing provider streamSimple export')
console.log(JSON.stringify({ module: specifier, electron: process.versions.electron, node: process.versions.node }))
`

export async function verifyPackagedRuntime(archivePath) {
  const archive = realpathSync(resolve(archivePath))
  const entries = new Set(listPackage(archive))
  const app = JSON.parse(extractFile(archive, 'package.json').toString())
  if (app.dependencies?.[provider] !== expectedVersion || app.devDependencies?.[provider]) {
    throw new Error(`Packaged ${provider} must be a production dependency pinned to ${expectedVersion}`)
  }
  const metadataPath = `node_modules/${provider}/package.json`
  if (!entries.has(`/${metadataPath}`)) throw new Error(`Missing packaged runtime dependency: ${metadataPath}`)
  const metadata = JSON.parse(extractFile(archive, metadataPath).toString())
  if (metadata.version !== expectedVersion) throw new Error(`Expected packaged ${provider}@${expectedVersion}, got ${metadata.version}`)
  const worker = [...entries].find(entry => /^\/out\/main\/chunks\/pi-task-worker-[^/]+\.js$/.test(entry))
  if (!worker) throw new Error('Missing packaged Pi task worker')
  const parent = join(archive, dirname(worker.slice(1)), '__runtime_probe__.mjs')
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  delete env.NODE_OPTIONS
  delete env.NODE_PATH
  const output = await new Promise((resolveOutput, reject) => {
    const child = spawn(require('electron'), [
      '--experimental-import-meta-resolve', '--input-type=module', '--eval', probe,
      archive, parent, providerModule,
    ], { cwd: dirname(archive), env, timeout: 30_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', data => { stdout += data })
    child.stderr.setEncoding('utf8').on('data', data => { stderr += data })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code !== 0) reject(new Error(`Packaged runtime import failed (${signal ?? code}): ${stderr || stdout}`))
      else resolveOutput(stdout.trim())
    })
  })
  return { version: app.version, ...JSON.parse(output) }
}

export async function verifyAfterPack(context) {
  const resources = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources')
  const result = await verifyPackagedRuntime(join(resources, 'app.asar'))
  console.log(`Verified packaged task provider imports: ${result.version}, target ${context.electronPlatformName}, host Electron ${result.electron}/${process.arch}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('usage: node scripts/verify-packaged-runtime.mjs <path/to/app.asar>')
    console.log(JSON.stringify(await verifyPackagedRuntime(process.argv[2])))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
