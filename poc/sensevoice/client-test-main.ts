import { app, BrowserWindow, dialog, utilityProcess } from 'electron'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SpeechService } from '../../electron/service/speech-service'
import { SpeechSettingsStore } from '../../electron/data/speech-settings-store'
import { SpeechRuntime } from '../../electron/runtime/speech-runtime'
import { registerRoutes } from '../../electron/controller/router'
import { speechRoutes } from '../../electron/controller/routes/speech'
import type { RequestContext } from '../../electron/controller/request-context'
import { installSpeechPermissions } from '../../electron/bootstrap/speech-permissions'

const root = resolve(process.env.SEP_SPEECH_TEST_ROOT!)
const directory = resolve(process.env.SEP_SPEECH_TEST_DIR!)
app.setPath('userData', resolve(process.env.SEP_SPEECH_TEST_PROFILE!))
app.commandLine.appendSwitch('use-fake-device-for-media-stream')
app.commandLine.appendSwitch('use-file-for-fake-audio-capture', join(root, 'resources/speech/sensevoice-int8/test_wavs/zh.wav'))
Object.defineProperty(dialog, 'showMessageBox', { value: async () => ({ response: process.env.SEP_SPEECH_TEST_DENY === '1' ? 1 : 0, checkboxChecked: false }) })

void app.whenReady().then(async () => {
  const runtime = new SpeechRuntime({ modelDir: join(root, 'resources/speech/sensevoice-int8'), createWorker: () => {
    const worker = utilityProcess.fork(join(root, 'out/main/speech-worker.js'), [], { serviceName: 'Speech integration test', stdio: 'pipe' })
    worker.stdout?.on('data', () => undefined)
    worker.stderr?.on('data', () => undefined)
    return {
      postMessage: value => { if (worker.pid) worker.postMessage(value); else worker.once('spawn', () => worker.postMessage(value)) },
      kill: () => worker.kill(), on: (_event, callback) => worker.on('message', callback), once: (_event, callback) => worker.once('exit', callback),
    }
  } })
  const speech = new SpeechService({
    scope: { currentScope: () => ({ enterpriseId: 'test-e', memberId: 'test-u' }) }, settings: new SpeechSettingsStore(app.getPath('userData')),
    runtime: async () => runtime, stopRuntime: () => runtime.stop(),
  })
  const window = new BrowserWindow({ show: false, width: 1200, height: 850, webPreferences: {
    preload: join(root, 'out/preload/index.mjs'), nodeIntegration: false, contextIsolation: true, sandbox: false,
  } })
  const url = pathToFileURL(join(directory, 'renderer/poc/sensevoice/client-test.html')).href
  installSpeechPermissions(window, url, speech)
  registerRoutes({ speech, window: () => window.isDestroyed() ? null : window } as RequestContext, { routes: speechRoutes, listeners: [] })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }))
  window.on('closed', () => { speech.stop(); app.quit() })
  app.on('before-quit', () => speech.stop())
  await window.loadURL(url)
  window.showInactive()
})
