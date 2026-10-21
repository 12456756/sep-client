import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SpeechInputController, type SpeechClientApi, type MicrophoneCapture, type CaptureOptions } from './speech-controller'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture() {
  let starts = 0, cancels = 0, recognitions = 0, backendCancels = 0
  const results: string[] = []
  let capturedOptions!: CaptureOptions
  const api: SpeechClientApi = {
    beginSpeechRecording: async ({ recordingId }) => ({ success: true, data: { recordingId, ready: true, permission: 'granted' } }),
    recognizeSpeech: async ({ recordingId }) => { recognitions++; return { success: true, data: { recordingId, text: '识别文字', silent: false } } },
    cancelSpeechRecording: async () => { backendCancels++; return { success: true } },
  }
  const capture: MicrophoneCapture = { stop: async () => ({ sampleRate: 16000, samples: new Float32Array(1600).fill(0.1) }), cancel: () => { cancels++ } }
  const controller = new SpeechInputController({
    api: () => api,
    capture: async options => { starts++; capturedOptions = options; return capture },
    id: () => 'test-recording',
  })
  return { api, controller, results, capture, get options() { return capturedOptions }, get starts() { return starts }, get cancels() { return cancels }, get backendCancels() { return backendCancels }, get recognitions() { return recognitions }, result: (text: string) => results.push(text) }
}

describe('shared speech input lifecycle', () => {
  it('cleans up a rejected microphone startup and can immediately retry', async () => {
    const f = fixture()
    const failure = Object.assign(new Error('permission denied'), { name: 'NotAllowedError' })
    const starting = deferred<MicrophoneCapture>()
    let signal!: AbortSignal
    let calls = 0
    const controller = new SpeechInputController({ api: () => f.api, capture: async options => { signal = options.signal; return ++calls === 1 ? starting.promise : f.capture } })
    const pending = controller.start('one', f.result)
    await new Promise(resolve => setImmediate(resolve))
    starting.reject(failure)
    await pending
    assert.equal(controller.getSnapshot().phase, 'idle')
    assert.match(controller.getSnapshot().error ?? '', /权限/)
    assert.equal(signal.aborted, true)
    assert.equal(f.backendCancels, 1)
    assert.deepEqual(f.results, [])
    await controller.start('two', f.result)
    assert.equal(controller.getSnapshot().phase, 'recording')
    controller.cancel()
  })
  it('cancels late capture resources without disturbing a newer owner', async () => {
    const f = fixture()
    const late = deferred<MicrophoneCapture>()
    let calls = 0
    const controller = new SpeechInputController({ api: () => f.api, capture: async () => ++calls === 1 ? late.promise : f.capture })
    const pending = controller.start('one', f.result)
    await new Promise(resolve => setImmediate(resolve))
    controller.cancel('one')
    await controller.start('two', f.result)
    let lateCancels = 0
    late.resolve({ ...f.capture, cancel: () => { lateCancels++ } })
    await pending
    assert.equal(lateCancels, 1)
    assert.equal(controller.getSnapshot().owner, 'two')
    assert.equal(controller.getSnapshot().phase, 'recording')
    controller.cancel()
  })
  it('all owners share a single recording slot and results return only to its owner', async () => {
    const f = fixture()
    await f.controller.start('one', f.result)
    await f.controller.start('two', () => assert.fail('wrong owner'))
    assert.equal(f.starts, 1)
    await f.controller.stop('two')
    assert.equal(f.recognitions, 0)
    await f.controller.stop('one')
    assert.deepEqual(f.results, ['识别文字'])
    assert.equal(f.controller.getSnapshot().phase, 'idle')
  })
  it('first permission approval does not start hardware recording', async () => {
    const f = fixture()
    f.api.beginSpeechRecording = async ({ recordingId }) => ({ success: true, data: { recordingId, ready: false, permission: 'granted' } })
    await f.controller.start('one', f.result)
    assert.equal(f.starts, 0)
    assert.equal(f.controller.getSnapshot().phase, 'idle')
  })
  it('release while authorization is pending prevents late microphone startup', async () => {
    const f = fixture()
    const approval = deferred<Awaited<ReturnType<SpeechClientApi['beginSpeechRecording']>>>()
    f.api.beginSpeechRecording = () => approval.promise
    const starting = f.controller.start('one', f.result)
    await f.controller.stop('one')
    approval.resolve({ success: true, data: { recordingId: 'test-recording', ready: true, permission: 'granted' } })
    await starting
    assert.equal(f.starts, 0)
    assert.deepEqual(f.results, [])
  })
  it('cancelling during inference drops stale transcripts', async () => {
    const f = fixture()
    const result = deferred<Awaited<ReturnType<SpeechClientApi['recognizeSpeech']>>>()
    f.api.recognizeSpeech = () => result.promise
    await f.controller.start('one', f.result)
    const stopping = f.controller.stop('one')
    await new Promise(resolve => setImmediate(resolve))
    f.controller.cancel('one')
    result.resolve({ success: true, data: { recordingId: 'test-recording', text: 'stale', silent: false } })
    await stopping
    assert.deepEqual(f.results, [])
    assert.equal(f.cancels > 0, true)
  })
  it('disconnected microphones and silence preserve the draft without sending anything', async () => {
    const f = fixture()
    await f.controller.start('one', f.result)
    f.options.onError(new Error('Microphone disconnected'))
    assert.equal(f.controller.getSnapshot().phase, 'idle')
    assert.equal(f.cancels > 0, true)
    f.api.recognizeSpeech = async ({ recordingId }) => ({ success: true, data: { recordingId, text: '', silent: true } })
    await f.controller.start('one', f.result)
    await f.controller.stop('one')
    assert.deepEqual(f.results, [])
    assert.match(f.controller.getSnapshot().error ?? '', /声音/)
  })
})
