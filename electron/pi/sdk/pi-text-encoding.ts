import { isUtf8 } from 'node:buffer'
import { analyse } from 'chardet'

type EncodingDetector = (bytes: Uint8Array) => Array<{ name: string; confidence: number }>
const MAX_DETECTION_BYTES = 65_536
const MAX_FRAME_BYTES = 8_192
const MAX_PENDING_BYTES = 65_536

/** Decode only raw bytes. Already-decoded SDK/MCP strings must never pass through this function. */
export function decodeToolText(bytes: Buffer, detect: EncodingDetector = analyse): string {
  const baseline = bytes.toString('utf8')
  try {
    if (bytes.subarray(0, 4).equals(Buffer.from([0xff, 0xfe, 0, 0])) ||
      bytes.subarray(0, 4).equals(Buffer.from([0, 0, 0xfe, 0xff]))) return baseline
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder('utf-16le', { fatal: true }).decode(bytes)
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder('utf-16be', { fatal: true }).decode(bytes)
    }
    if (isUtf8(bytes)) return baseline
    const sample = bytes.subarray(0, MAX_DETECTION_BYTES)
    if (sample.filter(byte => byte >= 0x80).length < 8) return baseline
    const matches = detect(sample)
    const best = matches[0]
    if (!best || best.confidence < 90 || best.confidence - (matches[1]?.confidence ?? 0) < 15) return baseline
    const text = new TextDecoder(best.name, { fatal: true }).decode(bytes)
    // Reject binary/control-heavy candidates, even when statistical detection is confident.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f-\u009f\ufffd]/u.test(text)) return baseline
    return text
  } catch {
    return baseline
  }
}

export function utf8ChildEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    PYTHONIOENCODING: env.PYTHONIOENCODING ?? 'utf-8',
    PYTHONUTF8: env.PYTHONUTF8 ?? '1',
    LANG: env.LANG ?? 'C.UTF-8',
  }
}

type Source = 'stdout' | 'stderr'
interface Frame { source: Source; bytes: Buffer; text?: string; bom?: Buffer }
interface SourceState { pending?: Frame; bom?: Buffer; started: boolean }

/** Number of missing bytes when the buffer is solely an incomplete UTF-8 character. */
function missingUtf8Bytes(bytes: Buffer): number {
  const first = bytes[0]
  const length = first >= 0xc2 && first <= 0xdf ? 2
    : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 0
  if (bytes.length >= length || !length) return 0
  for (let i = 1; i < bytes.length; i++) if ((bytes[i] & 0xc0) !== 0x80) return 0
  return length - bytes.length
}

/** Keep independent byte boundaries, but emit frames in their original arrival order. */
export class OrderedToolOutput {
  private readonly states: Record<Source, SourceState> = {
    stdout: { started: false }, stderr: { started: false },
  }
  private readonly frames: Frame[] = []
  private pendingBytes = 0
  private finished = false

  constructor(
    private readonly emit: (bytes: Buffer) => void,
    private readonly recover: (bytes: Buffer) => string = decodeToolText,
  ) {}

  write(source: Source, bytes: Buffer): void {
    if (this.finished) return
    const state = this.states[source]
    let offset = 0
    while (offset < bytes.length) {
      let frame = state.pending
      if (!frame) {
        frame = { source, bytes: Buffer.alloc(0), bom: state.bom }
        this.frames.push(frame)
        state.pending = frame
      }
      const missing = !state.bom ? missingUtf8Bytes(frame.bytes) : 0
      let count = Math.min(bytes.length - offset, MAX_FRAME_BYTES - frame.bytes.length)
      if (missing) count = Math.min(count, missing)
      else if (!state.started && frame.bytes.length === 1 && [0xff, 0xfe].includes(frame.bytes[0])) count = 1
      else if (!state.bom) {
        const newline = bytes.indexOf(0x0a, offset)
        if (newline >= offset) count = Math.min(count, newline - offset + 1)
      }
      frame.bytes = Buffer.concat([frame.bytes, bytes.subarray(offset, offset + count)])
      offset += count
      this.pendingBytes += count

      if (!state.started && frame.bytes.length >= 2) {
        const head = frame.bytes.subarray(0, 2)
        if (head.equals(Buffer.from([0xff, 0xfe])) || head.equals(Buffer.from([0xfe, 0xff]))) {
          state.bom = Buffer.from(head)
        }
        state.started = true
      }
      if (state.bom) {
        // UTF-16 lines must be split on code units, never on an arbitrary 0x0a byte.
        const le = state.bom[0] === 0xff
        let end = -1
        for (let i = 0; i + 1 < frame.bytes.length; i += 2) {
          if (frame.bytes[i] === (le ? 0x0a : 0) && frame.bytes[i + 1] === (le ? 0 : 0x0a)) { end = i + 2; break }
        }
        if (end > 0 || frame.bytes.length >= MAX_FRAME_BYTES) {
          const tail = frame.bytes.subarray(end > 0 ? end : frame.bytes.length)
          frame.bytes = frame.bytes.subarray(0, end > 0 ? end : frame.bytes.length)
          this.resolve(frame)
          state.pending = undefined
          if (tail.length) {
            this.pendingBytes -= tail.length
            this.write(source, tail)
          }
        }
      } else if (isUtf8(frame.bytes)) {
        this.resolve(frame)
        state.pending = undefined
        state.started = true
      } else {
        // Forward valid UTF-8 immediately; retain only an incomplete trailing character.
        let split = -1
        for (let n = 1; n <= 3 && n < frame.bytes.length; n++) {
          const index = frame.bytes.length - n
          if (missingUtf8Bytes(frame.bytes.subarray(index)) && isUtf8(frame.bytes.subarray(0, index))) { split = index; break }
        }
        if (split > 0) {
          const tail = frame.bytes.subarray(split)
          frame.text = frame.bytes.subarray(0, split).toString('utf8')
          frame.bytes = frame.bytes.subarray(0, split)
          state.pending = undefined
          this.pendingBytes -= tail.length
          this.write(source, tail)
        } else if (frame.bytes.includes(0x0a) || frame.bytes.length >= MAX_FRAME_BYTES) {
          this.resolve(frame)
          state.pending = undefined
          state.started = true
        }
      }
      this.drain()
      // A stalled stream must not keep unlimited output from the other stream in memory.
      if (this.pendingBytes > MAX_PENDING_BYTES) {
        const first = this.frames.find(item => item.text === undefined)
        if (first) {
          this.resolve(first)
          if (this.states[first.source].pending === first) this.states[first.source].pending = undefined
        }
        this.drain()
      }
    }
  }

  finish(): void {
    if (this.finished) return
    this.finished = true
    for (const frame of this.frames) if (frame.text === undefined) this.resolve(frame)
    this.drain()
  }

  private resolve(frame: Frame): void {
    const bytes = frame.bom ? Buffer.concat([frame.bom, frame.bytes]) : frame.bytes
    try {
      const text = this.recover(bytes)
      frame.text = frame.bom && text === bytes.toString('utf8') ? frame.bytes.toString('utf8') : text
    } catch {
      frame.text = frame.bytes.toString('utf8')
    }
  }

  private drain(): void {
    while (this.frames[0]?.text !== undefined) {
      const frame = this.frames.shift()!
      this.pendingBytes -= frame.bytes.length
      if (frame.text) this.emit(Buffer.from(frame.text, 'utf8'))
    }
  }
}
