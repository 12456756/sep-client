import * as assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { compileFunction } from 'node:vm'
import * as ts from 'typescript'
import { speechModelDirectory } from '../data/speech-assets'
import { SpeechRuntime } from '../runtime/speech-runtime'

class Worker extends EventEmitter {
  pid: number | undefined
  killed = false
  messages: unknown[] = []
  kill(): boolean { this.killed = true; this.emit('exit'); return true }
  postMessage(message: unknown): void {
    if (this.killed) throw new Error('Worker already killed')
    this.messages.push(message)
  }
}

function fixture() {
  const worker = new Worker()
  let forkedPath = ''
  const source = readFileSync(new URL('./create-speech-runtime.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const dependencies: Record<string, unknown> = {
    electron: { app: { isPackaged: false, getAppPath: () => 'D:/test-app' }, utilityProcess: { fork: (file: string) => { forkedPath = file; return worker } } },
    'node:path': { join }, '../data/speech-assets': { speechModelDirectory }, '../runtime/speech-runtime': { SpeechRuntime },
  }
  const output = { exports: {} }
  compileFunction(compiled, ['require', 'exports', 'module'])(
    (id: string) => { assert.ok(id in dependencies, id); return dependencies[id] }, output.exports, output,
  )
  const factory = output.exports as { createSpeechRuntime(): SpeechRuntime }
  return { worker, runtime: factory.createSpeechRuntime(), path: () => forkedPath }
}

describe('production speech worker bootstrap', () => {
  it('locates the built worker from the app root, not the dynamic chunk directory', async () => {
    const f = fixture()
    const pending = f.runtime.recognize({ recordingId: 'a', sampleRate: 16000, samples: new Float32Array(10) })
    assert.equal(f.path(), join('D:/test-app', 'out', 'main', 'speech-worker.js'))
    f.worker.pid = 123
    f.worker.emit('spawn')
    assert.equal((f.worker.messages[0] as { modelDir: string }).modelDir, join('D:/test-app', 'resources', 'speech', 'sensevoice-int8'))
    f.worker.emit('message', { type: 'result', result: { recordingId: 'a', text: '', silent: true } })
    await pending
    f.runtime.stop()
  })
  it('never posts to a cancelled worker whose spawn event arrives late', async () => {
    const f = fixture()
    const pending = f.runtime.recognize({ recordingId: 'a', sampleRate: 16000, samples: new Float32Array(10) })
    f.runtime.stop()
    await assert.rejects(pending)
    assert.doesNotThrow(() => f.worker.emit('spawn'))
    assert.equal(f.worker.messages.length, 0)
  })
})
