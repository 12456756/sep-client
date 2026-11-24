import * as assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import { SpeechRuntime, type SpeechWorkerPort } from './speech-runtime'

class Worker extends EventEmitter implements SpeechWorkerPort {
  messages: unknown[] = []
  killed = false
  postMessage(value: unknown): void { this.messages.push(value) }
  kill(): void { this.killed = true }
}
const audio = (id: string) => ({ recordingId: id, sampleRate: 16000, samples: new Float32Array(1600) })
const result = (id: string) => ({ type: 'result', result: { recordingId: id, text: 'text', silent: false } })

describe('isolated speech inference runtime', () => {
  it('keeps the timed protocol separate and kills only the cancelled subtitle worker', async () => {
    const voice = new Worker(), subtitle = new Worker()
    const runtime = new SpeechRuntime({ createWorker: () => voice, modelDir: 'model' })
    const caption = new SpeechRuntime({ createWorker: () => subtitle, modelDir: 'model' })
    const input = runtime.recognize(audio('voice'))
    const controller = new AbortController()
    const pending = caption.recognizeTimed(audio('caption'), controller.signal)
    assert.equal((subtitle.messages[0] as { timed?: boolean }).timed, true)
    assert.equal((voice.messages[0] as { timed?: boolean }).timed, undefined)
    controller.abort()
    await assert.rejects(pending, /已取消/)
    assert.ok(subtitle.killed)
    assert.ok(!voice.killed)
    voice.emit('message', result('voice'))
    await input
    runtime.stop()
  })
  it('accepts aligned timed tokens and rejects missing, reversed or out-of-range timestamps', async () => {
    for (const [timestamps, shouldPass] of [[[0.02, 0.08], true], [[0.02], false], [[0.08, 0.02], false], [[0.02, 0.2], false]] as const) {
      const worker = new Worker()
      const runtime = new SpeechRuntime({ createWorker: () => worker, modelDir: 'model' })
      const pending = runtime.recognizeTimed(audio('timed'), new AbortController().signal)
      worker.emit('message', { type: 'timed-result', result: { recordingId: 'timed', text: '你好', tokens: ['你', '好'], timestamps, silent: false } })
      if (shouldPass) assert.deepEqual((await pending).timestamps, timestamps)
      else { await assert.rejects(pending, /异常/); assert.ok(worker.killed) }
      runtime.stop()
    }
  })
  it('reuses one worker and validates matching bounded responses', async () => {
    const worker = new Worker()
    let spawns = 0
    const runtime = new SpeechRuntime({ createWorker: () => { spawns++; return worker }, modelDir: 'trusted-model' })
    for (const id of ['a', 'b']) {
      const pending = runtime.recognize(audio(id))
      worker.emit('message', result(id))
      assert.equal((await pending).recordingId, id)
    }
    assert.equal(spawns, 1)
    runtime.stop()
    assert.equal(worker.killed, true)
  })
  it('rejects simultaneous inference without interrupting the original request', async () => {
    const worker = new Worker()
    const runtime = new SpeechRuntime({ createWorker: () => worker, modelDir: 'model' })
    const pending = runtime.recognize(audio('a'))
    await assert.rejects(runtime.recognize(audio('b')))
    worker.emit('message', result('a'))
    await pending
    runtime.stop()
  })
  it('kills malformed or mismatched workers without trusting their error text', async () => {
    for (const message of [result('wrong'), { type: 'error', recordingId: 'a', code: 'raw private path' }, { type: 'result', result: { recordingId: 'a', text: 'x'.repeat(20001), silent: false } }]) {
      const worker = new Worker()
      const runtime = new SpeechRuntime({ createWorker: () => worker, modelDir: 'model' })
      const pending = runtime.recognize(audio('a'))
      worker.emit('message', message)
      await assert.rejects(pending, error => error instanceof Error && !error.message.includes('private'))
      assert.equal(worker.killed, true)
    }
  })
  it('bounds inference time and permits retry with a fresh worker', async () => {
    const workers: Worker[] = []
    const runtime = new SpeechRuntime({ createWorker: () => { const worker = new Worker(); workers.push(worker); return worker }, modelDir: 'model', timeoutMs: 5 })
    await assert.rejects(runtime.recognize(audio('a')), /超时/)
    assert.equal(workers[0]!.killed, true)
    const next = runtime.recognize(audio('b'))
    workers[1]!.emit('message', result('b'))
    await next
    runtime.stop()
  })
  it('cancellation ignores late replies and process exit rejects the pending request', async () => {
    const worker = new Worker()
    const runtime = new SpeechRuntime({ createWorker: () => worker, modelDir: 'model' })
    const pending = runtime.recognize(audio('a'))
    worker.emit('exit')
    await assert.rejects(pending, /退出/)
    worker.emit('message', result('a'))
    runtime.stop()
  })
  it('releases the model after idle and sanitizes model loading failures', async () => {
    const worker = new Worker()
    const runtime = new SpeechRuntime({ createWorker: () => worker, modelDir: 'model', idleMs: 5 })
    const pending = runtime.recognize(audio('a'))
    worker.emit('message', result('a'))
    await pending
    await new Promise(resolve => setTimeout(resolve, 15))
    assert.equal(worker.killed, true)
    const next = runtime.recognize(audio('b'))
    worker.emit('message', { type: 'error', recordingId: 'b', code: 'MODEL_UNAVAILABLE' })
    await assert.rejects(next, /模型/)
    runtime.stop()
  })
})
