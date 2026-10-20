export const MAX_RECORDING_SECONDS = 30

export function signalStats(samples, sampleRate) {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000
    || !(samples instanceof Float32Array) || !samples.length || samples.length > sampleRate * MAX_RECORDING_SECONDS) {
    throw new Error('Invalid audio format or recording length')
  }
  let peak = 0, energy = 0, clippedSamples = 0
  for (const value of samples) {
    if (!Number.isFinite(value) || Math.abs(value) > 1) throw new Error('Invalid normalized audio sample')
    peak = Math.max(peak, Math.abs(value))
    energy += value * value
    if (Math.abs(value) >= 0.999) clippedSamples++
  }
  return { sampleRate, sampleCount: samples.length, durationSeconds: samples.length / sampleRate,
    peak, rms: Math.sqrt(energy / samples.length), clippedSamples }
}

export class CaptureBuffer {
  constructor(sampleRate) {
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000) throw new Error('Invalid sample rate')
    this.sampleRate = sampleRate
    this.sequence = 0
    this.sampleCount = 0
    this.chunks = []
    this.finished = false
  }
  append({ sequence, samples }) {
    if (this.finished || sequence !== this.sequence) throw new Error('Audio chunk sequence mismatch')
    signalStats(samples, this.sampleRate)
    if (this.sampleCount + samples.length > this.sampleRate * MAX_RECORDING_SECONDS) throw new Error('Recording exceeds 30 seconds')
    this.chunks.push(samples.slice())
    this.sampleCount += samples.length
    this.sequence++
  }
  finish({ sequence, sampleCount }) {
    if (this.finished || !sampleCount || sequence !== this.sequence || sampleCount !== this.sampleCount) {
      throw new Error('Missing or inconsistent audio tail')
    }
    this.finished = true
    const samples = new Float32Array(sampleCount)
    let offset = 0
    for (const chunk of this.chunks) { samples.set(chunk, offset); offset += chunk.length }
    this.chunks = []
    return samples
  }
}

export async function prepareAudio(samples, sampleRate, Resampler) {
  const source = signalStats(samples, sampleRate)
  let output = samples.slice()
  if (sampleRate !== 16000) {
    if (!Resampler) throw new Error('Native audio resampling is unavailable')
    output = new Resampler(sampleRate, 16000).flush(samples).slice()
  }
  let peak = 0
  for (const value of output) {
    if (!Number.isFinite(value)) throw new Error('Invalid resampler output')
    peak = Math.max(peak, Math.abs(value))
  }
  // Band-limited interpolation can overshoot; attenuate the whole signal instead of clipping peaks.
  const resamplingGain = peak > 1 ? 1 / peak : 1
  if (resamplingGain < 1) for (let index = 0; index < output.length; index++) output[index] *= resamplingGain
  return { sampleRate: 16000, samples: output, source, processed: signalStats(output, 16000), resamplingGain }
}

export function validateCaptureRequest(value) {
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'recordingId,sampleRate,samples'
    || typeof value.recordingId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(value.recordingId)) throw new Error('Invalid audio request')
  signalStats(value.samples, value.sampleRate)
  return value
}

export function validateAudioRequest(value) {
  validateCaptureRequest(value)
  if (value.sampleRate !== 16000) throw new Error('Model audio must use 16 kHz')
  return value
}
