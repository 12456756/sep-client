import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractFile, listPackage } from '@electron/asar'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

const require = createRequire(import.meta.url)
const provider = '@earendil-works/pi-ai'
const providerModule = `${provider}/api/openai-completions`
const expectedVersion = '0.83.0'
const documentWorker = 'out/main/document-preview-worker.js'
const xlsxMarker = 'packaged-xlsx-probe'

// Resolve from the task worker inside ASAR, never from this repository's node_modules.
const probe = `
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Module from 'node:module'
import { isAbsolute, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const [archive, parent, specifier, worker, marker] = process.argv.slice(1)
assert.ok(process.versions.electron, 'The packaged runtime probe must run under Electron')
const inArchive = file => {
  const location = relative(archive, file)
  return !isAbsolute(location) && !location.startsWith('..')
}
const url = import.meta.resolve(specifier, pathToFileURL(parent).href)
assert.ok(inArchive(fileURLToPath(url)), 'Provider resolved outside app.asar: ' + url)
const { streamSimple } = await import(url)
assert.equal(typeof streamSimple, 'function', 'Missing provider streamSimple export')

// An archive under the checkout can otherwise pick up missing ExcelJS dependencies from disk.
const resolveFilename = Module._resolveFilename
let externalDependency
Module._resolveFilename = function (...args) {
  const resolved = Reflect.apply(resolveFilename, this, args)
  if (isAbsolute(resolved) && args[1]?.filename && inArchive(args[1].filename) && !inArchive(resolved)) {
    externalDependency = args[0]
    throw new Error('Packaged document dependency resolved outside app.asar: ' + externalDependency)
  }
  return resolved
}
let receive
let respond
process.parentPort = {
  on(event, listener) { assert.equal(event, 'message'); receive = listener },
  postMessage(value) { respond(value) },
}
const bytes = new Uint8Array(readFileSync(0))
await import(pathToFileURL(worker).href)
const request = data => new Promise(resolve => { respond = resolve; receive({ data: { ...data, bytes } }) })
const preview = await request({ format: 'xlsx' })
assert.equal(preview.kind, 'html', 'Packaged XLSX preview failed: ' + JSON.stringify(preview.error))
assert.ok(preview.sections.some(section => section.title === 'Empty' && section.html.includes('空工作表')), 'Packaged XLSX preview lost the empty sheet')
assert.ok(preview.sections.some(section => section.html.includes(marker)), 'Packaged XLSX preview lost the test cell')
assert.equal(externalDependency, undefined, 'Packaged document dependency resolved outside app.asar: ' + externalDependency)
console.log(JSON.stringify({ module: specifier, xlsx: 'ready', electron: process.versions.electron, node: process.versions.node }))
`

export async function verifyPackagedRuntime(archivePath) {
  const archive = realpathSync(resolve(archivePath))
  const entries = new Set(listPackage(archive).map(entry => entry.replaceAll('\\', '/')))
  const app = JSON.parse(extractFile(archive, 'package.json').toString())
  if (app.dependencies?.[provider] !== expectedVersion || app.devDependencies?.[provider]) {
    throw new Error(`Packaged ${provider} must be a production dependency pinned to ${expectedVersion}`)
  }
  const metadataPath = `node_modules/${provider}/package.json`
  if (!entries.has(`/${metadataPath}`)) throw new Error(`Missing packaged runtime dependency: ${metadataPath}`)
  const metadata = JSON.parse(extractFile(archive, join('node_modules', provider, 'package.json')).toString())
  if (metadata.version !== expectedVersion) throw new Error(`Expected packaged ${provider}@${expectedVersion}, got ${metadata.version}`)
  const worker = [...entries].find(entry => /^\/out\/main\/chunks\/pi-task-worker-[^/]+\.js$/.test(entry))
  if (!worker) throw new Error('Missing packaged Pi task worker')
  if (!entries.has(`/${documentWorker}`)) throw new Error('Missing packaged document preview worker')
  const parent = join(archive, dirname(worker.slice(1)), '__runtime_probe__.mjs')
  const workbook = new (require('exceljs').Workbook)()
  const sheet = workbook.addWorksheet('Probe')
  sheet.getCell('A1').value = xlsxMarker
  workbook.addWorksheet('Empty')
  const parts = unzipSync(new Uint8Array(await workbook.xlsx.writeBuffer()))
  // Reproduce Open XML exporters that prefix the spreadsheet's main namespace.
  for (const part of ['xl/workbook.xml', 'xl/worksheets/sheet2.xml']) {
    const xml = strFromU8(parts[part])
    parts[part] = strToU8(xml.replace('xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
      'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"').replace(/(<\/?)([\w.-]+)(?=[\s/>])/g, '$1x:$2'))
  }
  const xlsx = zipSync(parts)
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  delete env.NODE_OPTIONS
  delete env.NODE_PATH
  const output = await new Promise((resolveOutput, reject) => {
    const child = spawn(require('electron'), [
      '--experimental-import-meta-resolve', '--input-type=module', '--eval', probe,
      archive, parent, providerModule, join(archive, documentWorker), xlsxMarker,
    ], { cwd: dirname(archive), env, timeout: 30_000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', data => { stdout += data })
    child.stderr.setEncoding('utf8').on('data', data => { stderr += data })
    child.on('error', reject)
    // If validation exits before reading stdin, prefer the child's diagnostic.
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error) })
    child.stdin.end(xlsx)
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
  console.log(`Verified packaged task provider imports and XLSX preview: ${result.version}, target ${context.electronPlatformName}, host Electron ${result.electron}/${process.arch}`)
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
