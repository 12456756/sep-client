import { createRequire } from 'node:module'
import { readFile, stat } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { cpus } from 'node:os'
import { resolve } from 'node:path'
import { z } from 'zod'
import { analyzeWaveform, buildRecognizerConfig, validateWav, verifyFile } from './common.mjs'
import { prepareAudio, validateAudioRequest, validateCaptureRequest } from './audio-processing.mjs'

const require = createRequire(import.meta.url)
const requestSchema = z.object({
  modelDir: z.string().min(1), wav: z.string().min(1), fixture: z.boolean(),
  threads: z.number().int().min(1).max(8), runs: z.number().int().min(1).max(10),
}).strict()

async function recognize(options) {
  const validationStart = performance.now()
  const manifest = JSON.parse(await readFile(new URL('../../resources/speech/sensevoice-int8/manifest.json', import.meta.url), 'utf8'))
  for (const asset of manifest.files) {
    if (asset.path === 'test_wavs/zh.wav' && !options.fixture) continue
    await verifyFile(resolve(options.modelDir, asset.path), asset)
  }
  const inputStat = await stat(options.wav)
  if (!inputStat.isFile() || inputStat.size > 2_000_000) throw new Error('POC WAV exceeds 2 MB')
  const wavBytes = await readFile(options.wav)
  validateWav(wavBytes)
  const validationMs = performance.now() - validationStart
  const importStart = performance.now()
  const sherpa = require('sherpa-onnx-node')
  const nativeImportMs = performance.now() - importStart
  // Electron's V8 sandbox forbids native external ArrayBuffers; request a copied buffer.
  const wave = sherpa.readWave(options.wav, false)
  const audio = analyzeWaveform(wave)
  const beforeLoadRss = process.memoryUsage().rss
  const loadStart = performance.now()
  const recognizer = new sherpa.OfflineRecognizer(buildRecognizerConfig(options))
  const modelLoadMs = performance.now() - loadStart
  const afterLoadRss = process.memoryUsage().rss
  const runs = []
  for (let index = 0; index < options.runs; index++) {
    const cpuStart = process.cpuUsage(), start = performance.now()
    const stream = recognizer.createStream()
    stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples })
    recognizer.decode(stream)
    const raw = recognizer.getResult(stream)
    const elapsedMs = performance.now() - start
    const result = z.object({ text: z.string().min(1), lang: z.string().optional(),
      emotion: z.string().optional(), event: z.string().optional() }).parse(raw)
    const cpu = process.cpuUsage(cpuStart)
    runs.push({ index: index + 1, text: result.text, language: result.lang, elapsedMs,
      realTimeFactor: elapsedMs / (audio.durationSeconds * 1000),
      cpuMs: (cpu.user + cpu.system) / 1000, rssMiB: process.memoryUsage().rss / 1048576 })
  }
  return { provider: 'cpu', threads: options.threads, model: manifest.model,
    sherpaVersion: require('sherpa-onnx-node/package.json').version, onnxruntimeVersion: sherpa.onnxruntimeVersion,
    electronVersion: process.versions.electron, nodeVersion: process.versions.node,
    platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model,
    audio, validationMs, nativeImportMs, modelLoadMs, beforeLoadRssMiB: beforeLoadRss / 1048576,
    afterLoadRssMiB: afterLoadRss / 1048576,
    peakRssMiB: process.resourceUsage().maxRSS / 1024, runs,
    referenceKind: options.fixture ? 'Published FP32 example output; not a human-annotated accuracy benchmark' : undefined,
    expectedText: options.fixture ? manifest.expectedText : undefined,
    fixtureMatches: options.fixture ? runs.every(run => run.text.replace(/[\p{P}\p{Z}\s]/gu, '')
      === manifest.expectedText.replace(/[\p{P}\p{Z}\s]/gu, '')) : undefined }
}

let audioEngine
let audioEngineOptions

async function recognizeAudio(raw) {
  const input = z.object({ kind: z.literal('audio'), modelDir: z.string().min(1), threads: z.number().int().min(1).max(8),
    recordingId: z.string(), sampleRate: z.literal(16000), samples: z.instanceof(Float32Array) }).strict().parse(raw)
  validateAudioRequest({ recordingId: input.recordingId, sampleRate: input.sampleRate, samples: input.samples })
  const audio = analyzeWaveform(input)
  if (audio.rms < 0.0001) return { recordingId: input.recordingId, text: '', silent: true, audio, elapsedMs: 0, modelLoadMs: 0 }
  const reusedModel = Boolean(audioEngine)
  const loadStart = performance.now()
  if (!audioEngine) {
    const manifest = JSON.parse(await readFile(new URL('../../resources/speech/sensevoice-int8/manifest.json', import.meta.url), 'utf8'))
    for (const asset of manifest.files.filter(asset => asset.path !== 'test_wavs/zh.wav')) {
      await verifyFile(resolve(input.modelDir, asset.path), asset)
    }
    audioEngine = new (require('sherpa-onnx-node').OfflineRecognizer)(buildRecognizerConfig(input))
    audioEngineOptions = { modelDir: input.modelDir, threads: input.threads }
  }
  if (audioEngineOptions.modelDir !== input.modelDir || audioEngineOptions.threads !== input.threads) throw new Error('Audio engine configuration changed')
  const modelLoadMs = reusedModel ? 0 : performance.now() - loadStart
  const startedAt = performance.now()
  const stream = audioEngine.createStream()
  stream.acceptWaveform({ sampleRate: input.sampleRate, samples: input.samples })
  audioEngine.decode(stream)
  const result = z.object({ text: z.string(), lang: z.string().optional() }).parse(audioEngine.getResult(stream))
  return { recordingId: input.recordingId, text: result.text, language: result.lang, silent: false,
    audio, elapsedMs: performance.now() - startedAt, modelLoadMs, reusedModel, rssMiB: process.memoryUsage().rss / 1048576 }
}

async function prepareCapture(raw) {
  const input = z.object({ kind: z.literal('prepare'), modelDir: z.string().min(1), threads: z.number().int().min(1).max(8),
    recordingId: z.string(), sampleRate: z.number().int().min(8000).max(96000), samples: z.instanceof(Float32Array) }).strict().parse(raw)
  validateCaptureRequest({ recordingId: input.recordingId, sampleRate: input.sampleRate, samples: input.samples })
  const prepared = await prepareAudio(input.samples, input.sampleRate, require('sherpa-onnx-node').LinearResampler)
  return { recordingId: input.recordingId, ...prepared }
}

let busy = false
process.parentPort.on('message', async ({ data }) => {
  const audio = data?.kind === 'audio'
  const preparation = data?.kind === 'prepare'
  if (busy) {
    process.parentPort.postMessage({ type: 'error', recordingId: data?.recordingId, error: 'Speech worker is busy' })
    return
  }
  busy = true
  try {
    if (preparation) process.parentPort.postMessage({ type: 'audio-prepared', result: await prepareCapture(data) })
    else if (audio) process.parentPort.postMessage({ type: 'audio-result', result: await recognizeAudio(data) })
    else process.parentPort.postMessage({ type: 'result', report: await recognize(requestSchema.parse(data)) })
  } catch (error) {
    process.parentPort.postMessage({ type: 'error', recordingId: audio || preparation ? data.recordingId : undefined,
      error: error instanceof Error ? error.message : String(error) })
  } finally {
    busy = false
  }
})
