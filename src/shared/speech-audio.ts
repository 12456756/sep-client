import { MAX_SPEECH_SECONDS } from './speech-contracts'

export function signalRms(samples: Float32Array): number {
  let energy = 0
  for (const value of samples) energy += value * value
  return samples.length ? Math.sqrt(energy / samples.length) : 0
}

export class SpeechCaptureBuffer {
  private sequence = 0
  private count = 0
  private finished = false
  private chunks: Float32Array[] = []

  constructor(readonly sampleRate: number) {
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000) throw new Error('Invalid sample rate')
  }

  get sampleCount(): number { return this.count }

  append(sequence: number, samples: Float32Array): void {
    if (this.finished || sequence !== this.sequence || !(samples instanceof Float32Array) || !samples.length
      || samples.length > 2048 || this.count + samples.length > this.sampleRate * MAX_SPEECH_SECONDS) throw new Error('Invalid audio chunk')
    for (const sample of samples) if (!Number.isFinite(sample) || Math.abs(sample) > 1) throw new Error('Invalid PCM')
    this.chunks.push(samples.slice())
    this.count += samples.length
    this.sequence++
  }

  finish(sequence: number, sampleCount: number): Float32Array {
    if (this.finished || sequence !== this.sequence || !sampleCount || sampleCount !== this.count) throw new Error('Incomplete audio tail')
    this.finished = true
    const samples = new Float32Array(sampleCount)
    let offset = 0
    for (const chunk of this.chunks) { samples.set(chunk, offset); offset += chunk.length }
    this.chunks = []
    return samples
  }
}

export interface SpeechResampler {
  new(inputRate: number, outputRate: number): { flush(samples: Float32Array): Float32Array }
}

export function prepareSpeechPcm(samples: Float32Array, sampleRate: number, Resampler: SpeechResampler): Float32Array {
  const output = sampleRate === 16000 ? samples.slice() : new Resampler(sampleRate, 16000).flush(samples).slice()
  if (!output.length || output.length > 16000 * MAX_SPEECH_SECONDS) throw new Error('Invalid resampled length')
  let peak = 0
  for (const value of output) {
    if (!Number.isFinite(value)) throw new Error('Invalid resampler output')
    peak = Math.max(peak, Math.abs(value))
  }
  if (peak > 1) for (let index = 0; index < output.length; index++) output[index] /= peak
  return output
}
