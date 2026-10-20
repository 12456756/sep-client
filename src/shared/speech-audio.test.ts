import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { speechAudioSchema } from './speech-contracts'
import { prepareSpeechPcm, signalRms, SpeechCaptureBuffer } from './speech-audio'

describe('production speech PCM boundaries', () => {
  it('bounds duration, sample rate and normalized samples without accepting paths', () => {
    const base = { recordingId: 'a', sampleRate: 16000, samples: new Float32Array(10) }
    assert.equal(speechAudioSchema.safeParse(base).success, true)
    for (const patch of [{ samples: new Float32Array(0) }, { samples: new Float32Array(480001) }, { samples: new Float32Array([NaN]) }, { samples: new Float32Array([1.1]) }, { sampleRate: 1000 }, { modelDir: 'untrusted' }, { samples: [0.1] }]) {
      assert.equal(speechAudioSchema.safeParse({ ...base, ...patch }).success, false)
    }
  })
  it('owns chunks and verifies sequence and final partial-tail markers', () => {
    const buffer = new SpeechCaptureBuffer(48000)
    const chunk = new Float32Array([0.1, 0.2, 0.3])
    buffer.append(0, chunk)
    chunk.fill(0)
    assert.throws(() => buffer.append(0, chunk))
    assert.throws(() => buffer.finish(1, 2))
    const result = buffer.finish(1, 3)
    assert.ok(result[2]! > 0.29)
    assert.throws(() => buffer.finish(1, 3))
    assert.throws(() => buffer.append(1, chunk))
    assert.throws(() => new SpeechCaptureBuffer(0))
  })
  it('retains the final sample, copies native buffers and attenuates overshoot without boosting quiet audio', () => {
    const input = new Float32Array([0.2, 0.4])
    class Resampler { flush(): Float32Array { return new Float32Array([1, 2]) } }
    const resampled = prepareSpeechPcm(input, 48000, Resampler)
    assert.deepEqual([...resampled], [0.5, 1])
    assert.deepEqual([...prepareSpeechPcm(input, 16000, Resampler)], [...input])
    assert.equal(signalRms(new Float32Array()), 0)
    assert.equal(signalRms(new Float32Array([0.5, -0.5])), 0.5)
    class Invalid { flush(): Float32Array { return new Float32Array([NaN]) } }
    assert.throws(() => prepareSpeechPcm(input, 48000, Invalid))
  })
})
