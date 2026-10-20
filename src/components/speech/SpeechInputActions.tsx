import { LoaderCircle, Mic, Square, X } from 'lucide-react'
import type { SpeechInputBinding } from '../../features/speech/use-speech-input'
import '../../styles/speech.css'

export function SpeechInputActions({ speech, disabled = false }: { speech: SpeechInputBinding; disabled?: boolean }) {
  const recording = speech.phase === 'recording'
  const waiting = speech.active && !recording
  return <span className="speech-actions" data-speech-owner={speech.owner}>
    {speech.active ? <span className="speech-status" role="status">{recording ? `${speech.seconds.toFixed(0)}s` : speech.phase === 'arming' ? '准备中' : '识别中'}</span> : null}
    <button type="button" className={`speech-icon${recording ? ' recording' : ''}`} aria-label={recording ? '停止录音' : '语音输入'}
      title={recording ? '停止录音' : '语音输入（输入框内长按空格录音，松开结束）'}
      disabled={disabled || !speech.available || (speech.busy && !recording)} aria-pressed={recording}
      onPointerDown={event => event.preventDefault()} onClick={recording ? speech.stop : speech.start}>
      {waiting ? <LoaderCircle size={16} className="speech-spin" aria-hidden /> : recording ? <Square size={15} aria-hidden /> : <Mic size={17} aria-hidden />}
    </button>
    {speech.active ? <button type="button" className="speech-icon" aria-label="取消语音输入" title="取消语音输入" onPointerDown={event => event.preventDefault()} onClick={speech.cancel}><X size={15} aria-hidden /></button> : null}
  </span>
}

export function SpeechInputFeedback({ speech }: { speech: SpeechInputBinding }) {
  if (!speech.error && !speech.notice) return null
  return <p className={`speech-feedback${speech.error ? ' error' : ''}`} role={speech.error ? 'alert' : 'status'}>{speech.error || speech.notice}</p>
}
