import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function parseOptions(args) {
  const allowed = new Set(['--model-dir', '--wav', '--threads', '--runs', '--timeout-ms', '--output'])
  const values = new Map()
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1]
    if (!allowed.has(key) || values.has(key) || !value || value.startsWith('--')) {
      throw new Error(`Invalid or duplicate argument: ${key}`)
    }
    values.set(key, value)
  }
  const integer = (key, fallback, max) => {
    const value = values.get(key) ?? String(fallback)
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) {
      throw new Error(`${key} must be an integer between 1 and ${max}`)
    }
    return Number(value)
  }
  const modelDir = resolve(values.get('--model-dir') ?? fileURLToPath(new URL('../../resources/speech/sensevoice-int8/', import.meta.url)))
  return {
    modelDir,
    wav: resolve(values.get('--wav') ?? resolve(modelDir, 'test_wavs/zh.wav')),
    fixture: !values.has('--wav'),
    threads: integer('--threads', 2, 8),
    runs: integer('--runs', 3, 10),
    timeoutMs: integer('--timeout-ms', 120_000, 300_000),
    output: resolve(values.get('--output') ?? 'artifacts/sensevoice/result.json'),
  }
}

export function buildRecognizerConfig({ modelDir, threads }) {
  return {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: { model: resolve(modelDir, 'model.int8.onnx'), useInverseTextNormalization: 1 },
      tokens: resolve(modelDir, 'tokens.txt'),
      numThreads: threads, provider: 'cpu', debug: 0,
    },
  }
}

export function validateWav(bytes) {
  if (bytes.length < 44 || bytes.length > 2_000_000 || bytes.toString('ascii', 0, 4) !== 'RIFF'
    || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) {
    throw new Error('Expected a complete RIFF WAV recording no larger than 2 MB')
  }
  let validFormat = false, dataBytes = 0
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4), start = offset + 8
    if (start + size > bytes.length) throw new Error('Truncated WAV chunk')
    const tag = bytes.toString('ascii', offset, offset + 4)
    if (tag === 'fmt ') {
      validFormat = size >= 16 && bytes.readUInt16LE(start) === 1 && bytes.readUInt16LE(start + 2) === 1
        && bytes.readUInt32LE(start + 4) === 16000 && bytes.readUInt32LE(start + 8) === 32000
        && bytes.readUInt16LE(start + 12) === 2 && bytes.readUInt16LE(start + 14) === 16
      if (!validFormat) throw new Error('POC WAV must be PCM16, mono, 16 kHz; no implicit conversion')
    }
    if (tag === 'data') dataBytes += size
    offset = start + size + (size % 2)
  }
  if (!validFormat || !dataBytes || dataBytes % 2 || dataBytes > 16000 * 2 * 30) {
    throw new Error('POC requires a format chunk and 1 sample to 30 seconds of PCM16 data')
  }
}

export function analyzeWaveform(wave) {
  if (!wave || wave.sampleRate !== 16000 || !(wave.samples instanceof Float32Array)) {
    throw new Error('POC requires 16 kHz mono Float32 audio; resampling is not part of this test')
  }
  const { samples, sampleRate } = wave
  if (!samples.length || samples.length > sampleRate * 30) {
    throw new Error('POC audio must contain between 1 sample and 30 seconds')
  }
  let peak = 0, sum = 0, clippedSamples = 0
  for (const sample of samples) {
    if (!Number.isFinite(sample) || Math.abs(sample) > 1) throw new Error('Invalid normalized audio sample')
    peak = Math.max(peak, Math.abs(sample))
    sum += sample * sample
    if (Math.abs(sample) >= 0.999) clippedSamples++
  }
  return { sampleRate, sampleCount: samples.length, durationSeconds: samples.length / sampleRate,
    peak, rms: Math.sqrt(sum / samples.length), clippedSamples }
}

export async function verifyFile(path, expected) {
  const info = await stat(path).catch(() => { throw new Error(`Missing asset: ${path}`) })
  if (!info.isFile() || info.size !== expected.bytes) throw new Error(`Asset size mismatch: ${path}`)
  const hash = createHash(expected.sha256 ? 'sha256' : 'sha1')
  if (!expected.sha256) hash.update(`blob ${info.size}\0`)
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  if (hash.digest('hex') !== (expected.sha256 ?? expected.gitSha1)) throw new Error(`Asset checksum mismatch: ${path}`)
}
