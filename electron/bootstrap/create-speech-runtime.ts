import { app, utilityProcess } from 'electron'
import { join } from 'node:path'
import { speechModelDirectory } from '../data/speech-assets'
import { SpeechRuntime, type SpeechWorkerPort } from '../runtime/speech-runtime'

export function createSpeechRuntime(): SpeechRuntime {
  return new SpeechRuntime({
    modelDir: speechModelDirectory(app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')),
    createWorker: () => {
      const worker = utilityProcess.fork(join(app.getAppPath(), 'out', 'main', 'speech-worker.js'), [], { serviceName: 'SEP offline speech', stdio: 'pipe' })
      worker.stdout?.on('data', () => undefined)
      worker.stderr?.on('data', () => undefined)
      let stopped = false
      const port: SpeechWorkerPort = {
        postMessage: message => {
          if (worker.pid) worker.postMessage(message)
          else worker.once('spawn', () => {
            if (stopped) return
            try { worker.postMessage(message) } catch { worker.kill() }
          })
        },
        kill: () => { stopped = true; return worker.kill() },
        on: (_event, callback) => worker.on('message', callback),
        once: (_event, callback) => worker.once('exit', callback),
      }
      return port
    },
  })
}
