import { app, BrowserWindow, dialog, session, utilityProcess } from 'electron'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'
import { parseOptions } from './common.mjs'
import { registerRecorderRoutes } from './recorder-controller.mjs'

let options
const directory = resolve(process.env.SEP_SPEECH_RECORDER_DIR ?? 'artifacts/sensevoice/recorder')
const pageUrl = pathToFileURL(join(directory, 'recorder.html')).href
const testMode = process.env.SEP_SPEECH_POC_TEST === '1'
if (testMode) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  if (process.env.SEP_SPEECH_POC_TEST_AUDIO) app.commandLine.appendSwitch('use-file-for-fake-audio-capture', resolve(process.env.SEP_SPEECH_POC_TEST_AUDIO))
}
let window, worker, activeId, armingId, pending, idleTimer, disposeRoutes, profile
let closing = false

function stopWorker(error = 'CANCELLED') {
  clearTimeout(idleTimer)
  if (pending) {
    clearTimeout(pending.timer)
    pending.reject(new Error(error))
    pending = undefined
  }
  const current = worker
  worker = undefined
  current?.kill()
}

function getWorker() {
  clearTimeout(idleTimer)
  if (worker) return worker
  const current = utilityProcess.fork(fileURLToPath(new URL('./worker.mjs', import.meta.url)), [], {
    serviceName: 'SenseVoice microphone POC', stdio: 'pipe',
  })
  worker = current
  // Native diagnostics must not include the transcript or audio in application logs.
  current.stderr?.on('data', () => undefined)
  current.stdout?.on('data', () => undefined)
  current.on('message', raw => {
    if (worker !== current || !pending) return
    const parsed = z.discriminatedUnion('type', [
      z.object({ type: z.literal('audio-result'), result: z.object({ recordingId: z.string(), text: z.string(),
        silent: z.boolean(), elapsedMs: z.number().nonnegative(), modelLoadMs: z.number().nonnegative(),
        reusedModel: z.boolean().optional(), rssMiB: z.number().optional(),
        audio: z.object({ sampleRate: z.literal(16000), sampleCount: z.number().int().positive(),
          durationSeconds: z.number().positive(), peak: z.number(), rms: z.number(), clippedSamples: z.number() }) }).strip() }),
      z.object({ type: z.literal('error'), recordingId: z.string().optional(), error: z.string() }),
      z.object({ type: z.literal('audio-prepared'), result: z.object({ recordingId: z.string(), sampleRate: z.literal(16000),
        resamplingGain: z.number().positive().max(1),
        samples: z.instanceof(Float32Array), source: z.object({ sampleRate: z.number(), sampleCount: z.number(),
          durationSeconds: z.number(), peak: z.number(), rms: z.number(), clippedSamples: z.number() }),
        processed: z.object({ sampleRate: z.literal(16000), sampleCount: z.number(), durationSeconds: z.number(),
          peak: z.number(), rms: z.number(), clippedSamples: z.number() }) }) }),
    ]).safeParse(raw)
    if (!parsed.success) { activeId = undefined; stopWorker('Invalid speech worker response'); return }
    const message = parsed.data
    const id = message.type === 'error' ? message.recordingId : message.result.recordingId
    if (id !== pending.recordingId) { activeId = undefined; stopWorker('Speech worker request mismatch'); return }
    if (message.type === 'error') { activeId = undefined; stopWorker(message.error); return }
    if (message.type !== pending.expectedType) { activeId = undefined; stopWorker('Unexpected speech worker response'); return }
    const completion = pending
    pending = undefined
    if (message.type === 'audio-result') activeId = undefined
    clearTimeout(completion.timer)
    completion.resolve(message.result)
    idleTimer = setTimeout(() => stopWorker(), 5 * 60_000)
    idleTimer.unref()
  })
  current.once('exit', () => {
    if (worker !== current) return
    worker = undefined
    activeId = undefined
    stopWorker('Speech worker exited unexpectedly')
  })
  return current
}

async function arm(recordingId) {
  if (activeId || armingId || closing) throw new Error('BUSY')
  armingId = recordingId
  try {
    const allowed = testMode ? process.env.SEP_SPEECH_POC_DENY_MIC !== '1'
      : (await dialog.showMessageBox(window, { type: 'question',
        message: '\u5141\u8bb8\u6b64\u6b21\u4f7f\u7528\u9ea6\u514b\u98ce\uff1f',
        buttons: ['\u5141\u8bb8', '\u53d6\u6d88'], defaultId: 1, cancelId: 1 })).response === 0
    if (!allowed || armingId !== recordingId || closing) throw new Error('MICROPHONE_DENIED')
    activeId = recordingId
    return { armed: true }
  } finally {
    if (armingId === recordingId) armingId = undefined
  }
}

function requestAudio(input, kind) {
  if (closing || input.recordingId !== activeId) throw new Error('Recording session is no longer active')
  if (pending) throw new Error('BUSY')
  const current = getWorker()
  return new Promise((resolveResult, reject) => {
    pending = { recordingId: input.recordingId, expectedType: kind === 'prepare' ? 'audio-prepared' : 'audio-result', resolve: resolveResult, reject,
      timer: setTimeout(() => { activeId = undefined; stopWorker('Speech recognition timed out') }, options.timeoutMs) }
    const message = { kind, modelDir: options.modelDir, threads: options.threads, ...input }
    try {
      if (current.pid) current.postMessage(message)
      else current.once('spawn', () => { if (worker === current && pending?.recordingId === input.recordingId) current.postMessage(message) })
    } catch { activeId = undefined; stopWorker('Could not send audio to the speech worker') }
  })
}

function cancel(recordingId) {
  if (armingId === recordingId) armingId = undefined
  if (activeId === recordingId) {
    activeId = undefined
    if (pending) stopWorker()
  }
  return { cancelled: true }
}

function isLocalResource(url) {
  try {
    if (!url.startsWith('file:')) return false
    const path = relative(directory, fileURLToPath(url))
    return path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(path)
  } catch { return false }
}

async function main() {
  const entry = fileURLToPath(import.meta.url)
  const entryIndex = process.argv.findIndex(argument => resolve(argument) === entry)
  if (entryIndex < 1) throw new Error('Recorder entrypoint is missing from process arguments')
  options = parseOptions(process.argv.slice(entryIndex + 1))
  profile = await mkdtemp(join(tmpdir(), 'sep-speech-recorder-'))
  app.setPath('userData', profile)
  await app.whenReady()
  const isolated = session.fromPartition(`speech-poc-${Date.now()}`)
  window = new BrowserWindow({ width: 900, height: 820, minWidth: 380, minHeight: 640, show: false,
    autoHideMenuBar: true, backgroundColor: '#f7f8fa',
    icon: resolve('build/icon.ico'),
    webPreferences: { preload: join(directory, 'recorder-preload.cjs'), nodeIntegration: false,
      contextIsolation: true, sandbox: true, webSecurity: true, session: isolated } })
  const trusted = content => content === window?.webContents && content.getURL() === pageUrl
  isolated.setPermissionCheckHandler((content, permission, _origin, details) => Boolean(activeId)
    && trusted(content) && details.isMainFrame && permission === 'media' && details.mediaType === 'audio')
  isolated.setPermissionRequestHandler((content, permission, callback, details) => callback(Boolean(activeId)
    && trusted(content) && permission === 'media' && details.isMainFrame === true
    && details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio'))
  isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !isLocalResource(details.url) }))
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.on('render-process-gone', () => { activeId = undefined; stopWorker('Recording window closed') })
  disposeRoutes = registerRecorderRoutes({ window: () => window, pageUrl, arm,
    prepare: input => requestAudio(input, 'prepare'), recognize: input => requestAudio(input, 'audio'), cancel })
  window.on('closed', () => { window = undefined; activeId = undefined; stopWorker(); app.quit() })
  await window.loadURL(pageUrl)
  if (!testMode) window.show()
}

app.on('before-quit', () => {
  closing = true
  armingId = undefined
  activeId = undefined
  stopWorker()
  disposeRoutes?.()
})
app.on('will-quit', () => { if (profile) void rm(profile, { recursive: true, force: true }).catch(() => undefined) })
void main().catch(error => { process.stderr.write(`Recorder startup failed: ${error.message}\n`); app.exit(1) })
