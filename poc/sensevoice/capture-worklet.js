/* global AudioWorkletProcessor, registerProcessor, sampleRate */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.block = new Float32Array(2048)
    this.used = 0
    this.sequence = 0
    this.sampleCount = 0
    this.stopped = false
    this.port.onmessage = ({ data }) => { if (data?.type === 'stop') this.stop() }
  }
  flush() {
    if (!this.used) return
    const samples = this.block.slice(0, this.used)
    this.port.postMessage({ type: 'chunk', sequence: this.sequence++, samples }, [samples.buffer])
    this.used = 0
  }
  stop() {
    if (this.stopped) return
    this.stopped = true
    this.flush()
    this.port.postMessage({ type: 'stopped', sequence: this.sequence, sampleCount: this.sampleCount })
  }
  process(inputs) {
    if (this.stopped) return false
    const channels = inputs[0]
    if (!channels?.length) return true
    for (let frame = 0; frame < channels[0].length; frame++) {
      let value = 0
      for (const channel of channels) value += channel[frame] / channels.length
      this.block[this.used++] = value
      this.sampleCount++
      if (this.used === this.block.length) this.flush()
      if (this.sampleCount >= sampleRate * 30) { this.stop(); return false }
    }
    return true
  }
}
registerProcessor('sensevoice-capture', CaptureProcessor)
