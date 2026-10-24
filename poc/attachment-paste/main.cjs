const { app, BrowserWindow, clipboard, ipcMain, nativeImage } = require('electron')
const assert = require('node:assert/strict')
const { mkdir, readFile, writeFile, mkdtemp, rm } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { pathToFileURL } = require('node:url')
const { createHash } = require('node:crypto')

// Exercises the production contextBridge/preload with native webContents.paste().
// Main import handlers are probes; authenticated task execution is tested separately.
const output = resolve(__dirname, '../../outputs/attachment-paste')
const evidence = { platform: process.platform, electron: process.versions.electron, checks: [], passed: false }
const imports = []
let window, root, originalClipboard
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const pause = () => new Promise(resolve => setTimeout(resolve, 50))
async function until(predicate) {
  const deadline = Date.now() + 5000
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('Native paste probe timed out')
    await pause()
  }
}
async function evaluate(code) { return window.webContents.executeJavaScript(code) }
async function paste(selector = '#editor') {
  window.show(); window.focus(); window.webContents.focus()
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`)
  window.webContents.paste()
  await pause()
}

app.whenReady().then(async () => {
  await mkdir(output, { recursive: true })
  originalClipboard = clipboard.availableFormats().map(format => [format, clipboard.readBuffer(format)])
  root = await mkdtemp(join(tmpdir(), 'sep-paste-poc-'))
  ipcMain.handle('attachment:import-files', async (_event, input) => {
    for (const path of input.paths) imports.push({ kind: 'file', hash: digest(await readFile(path)), sessionId: input.sessionId })
    return { success: true, data: { attachments: [] } }
  })
  ipcMain.handle('attachment:import-image', async (_event, input) => {
    imports.push({ kind: 'image', hash: digest(input.bytes), type: input.type, sessionId: input.sessionId })
    return { success: true, data: { attachments: [] } }
  })
  window = new BrowserWindow({ width: 900, height: 600, webPreferences: {
    contextIsolation: true, nodeIntegration: false, sandbox: false,
    preload: resolve(__dirname, '../../out/preload/index.mjs'),
  } })
  await window.loadFile(join(__dirname, 'index.html'))
  await until(() => evaluate('typeof window.disposePaste === "function"'))

  clipboard.writeText('https://example.test/local/path.txt')
  await paste()
  assert.equal(await evaluate('document.getElementById("editor").value'), 'https://example.test/local/path.txt')
  assert.equal(imports.length, 0)
  evidence.checks.push('plain-text-and-url-remain-text')

  const image = nativeImage.createFromBuffer(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64'))
  assert.equal(image.isEmpty(), false)
  clipboard.writeImage(image)
  await paste()
  await until(() => imports.length === 1)
  assert.equal(imports[0].kind, 'image')
  assert.equal(imports[0].sessionId, 'session-native-poc')
  evidence.checks.push('native-image-bytes-cross-production-contextBridge')

  clipboard.writeImage(image)
  await paste('#other')
  assert.equal(imports.length, 1)
  evidence.checks.push('unrelated-input-does-not-import')

  clipboard.write({ text: 'mixed text', image })
  await evaluate('document.getElementById("editor").value = "before after"; document.getElementById("editor").setSelectionRange(7, 12)')
  await paste()
  await until(() => imports.length === 2)
  assert.equal(await evaluate('document.getElementById("editor").value'), 'before mixed text')
  assert.equal((await evaluate('window.pasteEvidence.edits')).filter(edit => edit.text === 'mixed text').length, 1)
  evidence.checks.push('mixed-text-selection-replaced-once-synchronously')

  if (process.platform === 'darwin') {
    const file = join(root, 'native report.txt')
    await writeFile(file, 'native file evidence')
    clipboard.clear()
    clipboard.writeBuffer('public.file-url', Buffer.from(pathToFileURL(file).href))
    await paste()
    await until(() => imports.length === 3)
    assert.equal(imports[2].kind, 'file')
    assert.equal(imports[2].hash, digest(Buffer.from('native file evidence')))
    evidence.checks.push('macos-file-url-native-file-path-and-sha256')
  } else evidence.filePaste = 'Explorer clipboard format requires Windows host validation'

  await evaluate('window.disposePaste()')
  clipboard.writeImage(image)
  await paste()
  assert.equal(imports.length, process.platform === 'darwin' ? 3 : 2)
  evidence.checks.push('dispose-stops-native-import')
  evidence.events = await evaluate('window.pasteEvidence')
  assert.ok(evidence.events.events.every(event => event.trusted))
  await writeFile(join(output, 'native-paste.png'), (await window.webContents.capturePage()).toPNG())
  evidence.passed = true
}).catch(error => {
  evidence.failure = error.message
  process.exitCode = 1
}).finally(async () => {
  if (originalClipboard) {
    clipboard.clear()
    for (const [format, bytes] of originalClipboard) clipboard.writeBuffer(format, bytes)
  }
  if (root) await rm(root, { recursive: true, force: true })
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2))
  process.stdout.write(JSON.stringify({ passed: evidence.passed, checks: evidence.checks, failure: evidence.failure, output }) + '\n')
  app.exit(evidence.passed ? 0 : 1)
})
