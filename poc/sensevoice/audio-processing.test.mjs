import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import vm from 'node:vm'
import { CaptureBuffer, prepareAudio, validateAudioRequest } from './audio-processing.mjs'

describe('microphone PCM collection', () => {
  it('collects ordered chunks and checks the flushed tail', () => {
    const buffer = new CaptureBuffer(48000)
    buffer.append({ sequence: 0, samples: new Float32Array([0.25, -0.25]) })
    buffer.append({ sequence: 1, samples: new Float32Array([0.5]) })
    assert.deepEqual([...buffer.finish({ sequence: 2, sampleCount: 3 })], [0.25, -0.25, 0.5])
  })
  it('rejects missing, duplicate, empty and invalid chunks', () => {
    assert.throws(() => new CaptureBuffer(100))
    const buffer = new CaptureBuffer(48000)
    assert.throws(() => buffer.append({ sequence: 1, samples: new Float32Array([0]) }), /sequence/i)
    assert.throws(() => buffer.append({ sequence: 0, samples: new Float32Array() }))
    assert.throws(() => buffer.append({ sequence: 0, samples: [0] }))
    assert.throws(() => buffer.append({ sequence: 0, samples: new Float32Array([NaN]) }))
    buffer.append({ sequence: 0, samples: new Float32Array([0.1]) })
    assert.throws(() => buffer.append({ sequence: 0, samples: new Float32Array([0.1]) }))
    assert.throws(() => buffer.finish({ sequence: 1, sampleCount: 2 }), /tail/i)
  })
  it('bounds recording length and refuses empty recordings', () => {
    const buffer = new CaptureBuffer(8000)
    assert.throws(() => buffer.finish({ sequence: 0, sampleCount: 0 }))
    assert.throws(() => buffer.append({ sequence: 0, samples: new Float32Array(8000 * 30 + 1) }))
  })
  it('owns its sample data and cannot be finished twice', () => {
    const buffer = new CaptureBuffer(16000)
    const samples = new Float32Array([0.5])
    buffer.append({ sequence: 0, samples })
    samples[0] = 0
    assert.equal(buffer.finish({ sequence: 1, sampleCount: 1 })[0], 0.5)
    assert.throws(() => buffer.finish({ sequence: 1, sampleCount: 1 }))
    assert.throws(() => buffer.append({ sequence: 1, samples }))
  })
})

describe('microphone audio preparation', () => {
  it('does not rescale or resample audio already at 16 kHz', async () => {
    const result = await prepareAudio(new Float32Array([0.25, -0.25]), 16000)
    assert.deepEqual([...result.samples], [0.25, -0.25])
    assert.equal(result.sampleRate, 16000)
    assert.equal(result.source.sampleCount, 2)
  })
  it('uses the native resampler and flushes the final samples', async () => {
    let captured
    class Resampler {
      constructor(sourceRate, targetRate) { captured = { sourceRate, targetRate } }
      flush(samples) {
        captured.samples = [...samples]
        return new Float32Array([0.2, -0.2])
      }
    }
    const result = await prepareAudio(new Float32Array([0.1, 0.2, 0.3, -0.1, -0.2, -0.3]), 48000, Resampler)
    assert.equal(captured.sourceRate, 48000)
    assert.equal(captured.targetRate, 16000)
    assert.equal(captured.samples.length, 6)
    assert.equal(result.samples.length, 2)
    assert.equal(result.source.durationSeconds, result.processed.durationSeconds)
  })
  it('rejects invalid signals and resampling output', async () => {
    await assert.rejects(prepareAudio(new Float32Array(), 16000))
    await assert.rejects(prepareAudio(new Float32Array([Infinity]), 16000))
    await assert.rejects(prepareAudio(new Float32Array([2]), 16000))
    await assert.rejects(prepareAudio(new Float32Array(960001), 32000))
    await assert.rejects(prepareAudio(new Float32Array([0]), 1000))
    await assert.rejects(prepareAudio(new Float32Array([0]), 48000, null))
  })
  it('attenuates resampling overshoot without clipping or amplifying quiet audio', async () => {
    class Resampler {
      flush() { return new Float32Array([1.25, -0.625]) }
    }
    const result = await prepareAudio(new Float32Array([1, -1, 1, -1, 1, -1]), 48000, Resampler)
    assert.deepEqual([...result.samples], [1, -0.5])
    assert.equal(result.resamplingGain, 0.8)
    class Invalid { flush() { return new Float32Array([NaN]) } }
    await assert.rejects(prepareAudio(new Float32Array([0]), 48000, Invalid), /resampl/i)
  })
  it('validates the renderer payload without accepting paths or excess memory', () => {
    const request = { recordingId: 'recording-1', sampleRate: 16000, samples: new Float32Array([0.1]) }
    assert.equal(validateAudioRequest(request).recordingId, request.recordingId)
    assert.throws(() => validateAudioRequest({ ...request, modelDir: 'C:/' }))
    assert.throws(() => validateAudioRequest({ ...request, sampleRate: 48000 }))
    assert.throws(() => validateAudioRequest({ ...request, samples: new Float32Array(480001) }))
    assert.throws(() => validateAudioRequest({ ...request, recordingId: '' }))
    assert.throws(() => validateAudioRequest(null))
  })
})

describe('the actual AudioWorklet processor', () => {
  async function create(rate = 16000) {
    let Processor
    const messages = []
    const context = { sampleRate: rate, Float32Array, AudioWorkletProcessor: class {
      constructor() { this.port = { postMessage: message => messages.push(message) } }
    }, registerProcessor: (_name, implementation) => { Processor = implementation } }
    vm.runInNewContext(await readFile(new URL('./capture-worklet.js', import.meta.url), 'utf8'), context)
    return { processor: new Processor(), messages }
  }
  it('flushes a short final block exactly once and mixes two channels to mono', async () => {
    const { processor, messages } = await create()
    assert.equal(processor.process([[new Float32Array([0.5, 1]), new Float32Array([-0.5, 0])]]), true)
    processor.port.onmessage({ data: { type: 'stop' } })
    assert.deepEqual([...messages[0].samples], [0, 0.5])
    assert.equal(messages[0].sequence, 0)
    assert.equal(messages[1].type, 'stopped')
    assert.equal(messages[1].sampleCount, 2)
    processor.port.onmessage({ data: { type: 'stop' } })
    assert.equal(messages.length, 2)
    assert.equal(processor.process([]), false)
  })
  it('automatically stops at the exact sample limit without dropping the tail', async () => {
    const { processor, messages } = await create(8000)
    for (let i = 0; i < 1876; i++) processor.process([[new Float32Array(128)]])
    const stopped = messages.at(-1)
    assert.equal(stopped.type, 'stopped')
    assert.equal(stopped.sampleCount, 240000)
    const chunks = messages.filter(message => message.type === 'chunk')
    assert.equal(chunks.reduce((sum, chunk) => sum + chunk.samples.length, 0), 240000)
    assert.equal(stopped.sequence, chunks.length)
  })
})
