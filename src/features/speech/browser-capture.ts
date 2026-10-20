import workletUrl from './capture-worklet.js?url'
import { SpeechCaptureBuffer } from '../../shared/speech-audio'
import type { CapturedAudio, CaptureOptions, MicrophoneCapture } from './speech-controller'

class BrowserMicrophoneCapture implements MicrophoneCapture {
  private stream?: MediaStream
  private context?: AudioContext
  private node?: AudioWorkletNode
  private source?: MediaStreamAudioSourceNode
  private mute?: GainNode
  private buffer?: SpeechCaptureBuffer
  private completed?: CapturedAudio
  private stopped?: Promise<CapturedAudio>
  private finish?: (audio: CapturedAudio) => void
  private reject?: (error: Error) => void
  private tailTimer?: ReturnType<typeof setTimeout>
  private closed = false

  constructor(private readonly options: CaptureOptions) {}

  private readonly abort = (): void => this.cancel()

  async open(): Promise<void> {
    this.options.signal.addEventListener('abort', this.abort, { once: true })
    try {
      this.checkAborted()
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: { ideal: 1 } }, video: false })
      this.checkAborted()
      this.context = new AudioContext()
      await this.context.resume()
      this.checkAborted()
      await this.context.audioWorklet.addModule(workletUrl)
      this.checkAborted()
      this.buffer = new SpeechCaptureBuffer(this.context.sampleRate)
      this.node = new AudioWorkletNode(this.context, 'sep-speech-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
      this.node.onprocessorerror = () => this.fail(new Error('Capture processor failed'))
      this.node.port.onmessage = ({ data }: MessageEvent<unknown>) => this.message(data)
      this.source = this.context.createMediaStreamSource(this.stream)
      this.mute = this.context.createGain()
      this.mute.gain.value = 0
      this.source.connect(this.node)
      this.node.connect(this.mute).connect(this.context.destination)
      for (const track of this.stream.getAudioTracks()) track.onended = () => this.fail(new Error('Microphone disconnected'))
    } catch (error) { this.release(); throw error }
  }

  private checkAborted(): void {
    if (this.closed || this.options.signal.aborted) throw new DOMException('Capture cancelled', 'AbortError')
  }

  private message(raw: unknown): void {
    if (this.closed || !this.buffer || !raw || typeof raw !== 'object') return
    try {
      if ('type' in raw && raw.type === 'chunk' && 'sequence' in raw && typeof raw.sequence === 'number' && 'samples' in raw && raw.samples instanceof Float32Array) {
        this.buffer.append(raw.sequence, raw.samples)
        this.options.onProgress(this.buffer.sampleCount / this.buffer.sampleRate)
      } else if ('type' in raw && raw.type === 'stopped' && 'sequence' in raw && typeof raw.sequence === 'number' && 'sampleCount' in raw && typeof raw.sampleCount === 'number') {
        this.completed = { sampleRate: this.buffer.sampleRate, samples: this.buffer.finish(raw.sequence, raw.sampleCount) }
        const resolve = this.finish
        this.release()
        if (resolve) resolve(this.completed)
        else this.options.onLimit()
      } else throw new Error('Invalid capture message')
    } catch { this.fail(new Error('Audio capture is incomplete')) }
  }

  stop(): Promise<CapturedAudio> {
    if (this.completed) return Promise.resolve(this.completed)
    if (this.stopped) return this.stopped
    if (this.closed || !this.node) return Promise.reject(new Error('Microphone is not recording'))
    this.stopped = new Promise((resolve, reject) => {
      this.finish = resolve
      this.reject = reject
      this.tailTimer = setTimeout(() => this.fail(new Error('Audio tail timeout')), 2000)
      this.node!.port.postMessage({ type: 'stop' })
    })
    return this.stopped
  }

  private fail(error: Error): void {
    const reject = this.reject
    this.release()
    reject?.(error)
    this.options.onError(error)
  }

  private release(): void {
    this.closed = true
    clearTimeout(this.tailTimer)
    this.options.signal.removeEventListener('abort', this.abort)
    if (this.node) { this.node.port.onmessage = null; this.node.port.close(); this.node.disconnect(); this.node.onprocessorerror = null }
    this.source?.disconnect()
    this.mute?.disconnect()
    for (const track of this.stream?.getTracks() ?? []) { track.onended = null; track.stop() }
    if (this.context && this.context.state !== 'closed') void this.context.close().catch(() => undefined)
    this.buffer = undefined
    this.finish = undefined
    this.reject = undefined
  }

  cancel(): void {
    const reject = this.reject
    this.release()
    this.completed = undefined
    reject?.(new DOMException('Capture cancelled', 'AbortError'))
  }
}

export async function createMicrophoneCapture(options: CaptureOptions): Promise<MicrophoneCapture> {
  const capture = new BrowserMicrophoneCapture(options)
  await capture.open()
  return capture
}
