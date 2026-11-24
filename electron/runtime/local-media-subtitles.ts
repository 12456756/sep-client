import { randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import type { SubtitleRecognizer } from '../domain/timed-speech'
import { signalRms } from '../../src/shared/speech-audio'

export const subtitleSampleRate = 16_000
export const subtitleMaxSeconds = 3600
export const subtitleOutputLimit = 4 * 1024 ** 2
const coreSamples = 20 * subtitleSampleRate
const contextSamples = subtitleSampleRate
const sampleBytes = 2
const pauseSeconds = 0.8
const cueSeconds = 5
const singleCueChars = 40
const maxCues = 12_000
const quiet = 0.0001
type Cue = { startMs: number; endMs: number; text: string }

function srtTime(ms: number): string {
  const pad = (value: number, digits = 2) => String(value).padStart(digits, '0')
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`
}

function cleanToken(value: string): string {
  if (/^<\|[^|]+\|>$/.test(value)) return ''
  return [...value.replaceAll('▁', ' ').replace(/\s+/gu, ' ')].filter(char => !/\p{Cc}/u.test(char)).join('')
}

function cueBuilder(duration: number) {
  const cues: Cue[] = []
  const endMs = Math.floor(duration * 1000)
  let text = ''
  let first = 0
  let last = 0
  function flush(next = duration) {
    if (!text.trim()) return
    const start = Math.round(first * 1000)
    const end = Math.min(endMs, Math.floor(next * 1000), Math.round((first + cueSeconds) * 1000),
      Math.round(Math.max(first + 0.7, last + 0.35) * 1000))
    if (end > start) {
      // SubRip readers may interpret angle brackets as formatting tags.
      cues.push({ startMs: start, endMs: end, text: text.trim().replaceAll('<', '＜').replaceAll('>', '＞') })
      if (cues.length > maxCues) throw new Error('识别出的字幕条目过多，请将素材分段后重试。')
    }
    text = ''
  }
  return {
    word(token: string, at: number) {
      if (text && (at - last >= pauseSeconds || at - first >= cueSeconds - 0.3 ||
        ([...text, ...token].length > singleCueChars && at - first >= 0.7 && (token.startsWith(' ') || /\p{Script=Han}/u.test(token))) ||
        (/[。！？!?]$/u.test(text) && at - last >= 0.25))) flush(at)
      if (!text) first = at
      text += token
      last = at
    },
    punctuation(token: string) { if (text && token.trim()) text += token.trim() },
    finish() { flush(); return cues },
  }
}

export async function generateSubtitles(path: string, duration: number, createRecognizer: () => Promise<SubtitleRecognizer>,
  signal: AbortSignal, progress?: (percent: number) => void): Promise<{ srt: string; cueCount: number }> {
  const file = await open(path, 'r')
  let recognizer: SubtitleRecognizer | undefined
  try {
    const bytes = (await file.stat()).size
    const total = bytes / sampleBytes
    if (bytes % sampleBytes || total > Math.ceil(duration * subtitleSampleRate) + subtitleSampleRate) {
      throw new Error('字幕识别的中间音频长度异常。')
    }
    const builder = cueBuilder(duration)
    for (let start = 0; start < total; start += coreSamples) {
      signal.throwIfAborted()
      const end = Math.min(total, start + coreSamples)
      const from = Math.max(0, start - contextSamples)
      const to = Math.min(total, end + contextSamples)
      const buffer = Buffer.allocUnsafe((to - from) * sampleBytes)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, from * sampleBytes)
      if (bytesRead !== buffer.length) throw new Error('字幕识别的中间音频不完整。')
      const samples = new Float32Array(to - from)
      for (let i = 0; i < samples.length; i++) samples[i] = buffer.readInt16LE(i * sampleBytes) / 32768
      if (signalRms(samples.subarray(start - from, end - from)) >= quiet) {
        recognizer ??= await createRecognizer()
        signal.throwIfAborted()
        const { tokens, timestamps } = await recognizer.recognizeTimed({ recordingId: randomUUID(), sampleRate: subtitleSampleRate, samples }, signal)
        signal.throwIfAborted()
        let ownsPreviousWord = false
        for (const [index, raw] of tokens.entries()) {
          const token = cleanToken(raw)
          if (!token.trim()) continue
          if (!/[\p{L}\p{N}\p{M}]/u.test(token)) {
            // Punctuation can be timestamped at the tail of the window, after seconds of silence.
            if (ownsPreviousWord) builder.punctuation(token)
            continue
          }
          const position = Math.round(timestamps[index] * subtitleSampleRate)
          const absolute = from + position
          const radius = Math.round(subtitleSampleRate * 0.30)
          ownsPreviousWord = absolute >= start && absolute < end && absolute / subtitleSampleRate < duration &&
            signalRms(samples.subarray(Math.max(0, position - radius), Math.min(samples.length, position + radius))) >= quiet
          if (ownsPreviousWord) builder.word(token, absolute / subtitleSampleRate)
        }
      }
      progress?.(Math.min(99, Math.floor(100 * end / total)))
    }
    signal.throwIfAborted()
    const cues = builder.finish()
    if (!cues.length) throw new Error('未识别到可生成字幕的语音，没有保存空字幕。')
    const srt = cues.map((cue, i) => `${i + 1}\r\n${srtTime(cue.startMs)} --> ${srtTime(cue.endMs)}\r\n${cue.text}\r\n\r\n`).join('')
    if (Buffer.byteLength(srt) > subtitleOutputLimit) throw new Error('字幕文件超出大小限制，请将素材分段后重试。')
    return { srt, cueCount: cues.length }
  } finally {
    try { recognizer?.stop() } finally { await file.close() }
  }
}
