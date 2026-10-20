import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { speechAudioSchema, speechResultSchema } from '../../src/shared/speech-contracts'
import { prepareSpeechPcm, signalRms, type SpeechResampler } from '../../src/shared/speech-audio'
import { SPEECH_MODEL_ASSETS } from '../data/speech-assets'

interface Stream { acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void }
interface Recognizer { createStream(): Stream; decode(stream: Stream): void; getResult(stream: Stream): unknown }
interface Sherpa { OfflineRecognizer: new(config: unknown) => Recognizer; LinearResampler: SpeechResampler }
interface ParentPort { on(event: 'message', callback: (event: { data: unknown }) => void): void; postMessage(value: unknown): void }

const parent = (process as NodeJS.Process & { parentPort: ParentPort }).parentPort
const require = createRequire(import.meta.url)
const requestSchema = z.object({ modelDir: z.string().min(1), ...speechAudioSchema.shape }).strict().superRefine((value, ctx) => {
  const parsed = speechAudioSchema.safeParse({ recordingId: value.recordingId, sampleRate: value.sampleRate, samples: value.samples })
  if (!parsed.success) ctx.addIssue({ code: 'custom', message: 'Invalid audio input' })
})
let engine: Recognizer | undefined
let engineDirectory: string | undefined
let busy = false

async function loadEngine(modelDir: string, sherpa: Sherpa): Promise<Recognizer> {
  if (engine) {
    if (engineDirectory !== modelDir) throw new Error('Model configuration changed')
    return engine
  }
  for (const asset of SPEECH_MODEL_ASSETS) {
    const bytes = await readFile(join(modelDir, asset.path))
    if (bytes.length !== asset.bytes) throw new Error('Invalid model size')
    const actual = asset.algorithm === 'sha256' ? createHash('sha256').update(bytes).digest('hex')
      : createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    if (actual !== asset.hash) throw new Error('Invalid model hash')
  }
  engine = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { senseVoice: { model: join(modelDir, 'model.int8.onnx'), useInverseTextNormalization: 1 },
      tokens: join(modelDir, 'tokens.txt'), numThreads: 2, provider: 'cpu', debug: 0 },
  })
  engineDirectory = modelDir
  return engine
}

parent.on('message', ({ data }) => {
  void (async () => {
    const parsed = requestSchema.safeParse(data)
    if (!parsed.success) { parent.postMessage({ type: 'error', recordingId: '', code: 'RECOGNITION_FAILED' }); return }
    const input = parsed.data
    if (busy) { parent.postMessage({ type: 'error', recordingId: input.recordingId, code: 'BUSY' }); return }
    busy = true
    let code = 'RECOGNITION_FAILED'
    try {
      let text = ''
      const silent = signalRms(input.samples) < 0.0001
      if (!silent) {
        code = 'MODEL_UNAVAILABLE'
        const sherpa = require('sherpa-onnx-node') as Sherpa
        const recognizer = await loadEngine(input.modelDir, sherpa)
        code = 'RECOGNITION_FAILED'
        const samples = prepareSpeechPcm(input.samples, input.sampleRate, sherpa.LinearResampler)
        const stream = recognizer.createStream()
        stream.acceptWaveform({ sampleRate: 16000, samples })
        recognizer.decode(stream)
        text = z.object({ text: z.string() }).parse(recognizer.getResult(stream)).text
      }
      parent.postMessage({ type: 'result', result: speechResultSchema.parse({ recordingId: input.recordingId, text, silent }) })
    } catch { parent.postMessage({ type: 'error', recordingId: input.recordingId, code }) }
    finally { busy = false }
  })()
})
