import { useEffect, useId, useRef, useSyncExternalStore } from 'react'
import type { FocusEvent, KeyboardEvent } from 'react'
import { flushSync } from 'react-dom'
import { speechInput } from './speech-input'
import { SpaceHold } from './space-hold'
import { useFeedback } from '../../components/feedback/FeedbackProvider'
import { useOperationFeedback } from '../../components/feedback/use-operation-feedback'
import { responseError } from '../../shared/arrangement-feedback'
import { speechPermissionSchema } from '../../shared/speech-contracts'

type TextInput = HTMLInputElement | HTMLTextAreaElement
interface Options {
  contextKey: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}

export function useSpeechInput<T extends TextInput = HTMLTextAreaElement>(options: Options) {
  const feedback = useFeedback()
  const { capture } = useOperationFeedback(options.contextKey)
  const id = useId()
  const owner = `${id}:${options.contextKey}`
  const input = useRef<T>(null)
  const latest = useRef(options)
  latest.current = options
  const mountedOwner = useRef(owner)
  mountedOwner.current = owner
  const composing = useRef(false)
  const snapshot = useSyncExternalStore(speechInput.subscribe, speechInput.getSnapshot, speechInput.getSnapshot)
  const owns = snapshot.owner === owner
  const busy = snapshot.phase !== 'idle'
  const active = owns && busy
  const available = typeof window !== 'undefined' && typeof window.electronAPI?.beginSpeechRecording === 'function'
  const shown = useRef<typeof snapshot | null>(null)
  useEffect(() => {
    if (!owns) return
    const message = snapshot.error || snapshot.notice
    if (!message) { shown.current = null; return }
    if (shown.current === snapshot) return
    shown.current = snapshot
    capture().show(message, snapshot.error ? 'error' : 'success')
  }, [snapshot, owns, capture])

  const insert = (text: string, expectedOwner: string, range?: { start: number; end: number; value: string }): void => {
    const element = input.current
    if (!element || mountedOwner.current !== expectedOwner || latest.current.disabled) return
    const value = latest.current.value
    const unchanged = range?.value === value
    const start = unchanged ? range.start : element.selectionStart ?? value.length
    const end = unchanged ? range.end : element.selectionEnd ?? start
    const next = value.slice(0, start) + text + value.slice(end)
    // Commit the idle snapshot first so Chromium no longer sees a read-only input.
    if (element.readOnly && speechInput.getSnapshot().phase === 'idle') flushSync(() => {})
    element.setSelectionRange(start, end)
    // Chromium's edit command preserves the textarea undo stack; direct state writes do not.
    let inserted = false
    if (document.activeElement === element) flushSync(() => { inserted = document.execCommand('insertText', false, text) })
    if (inserted) return
    flushSync(() => latest.current.onChange(next))
    element.setSelectionRange(start + text.length, start + text.length)
  }

  const actions = useRef({ start: () => {}, stop: () => {}, cancel: () => {}, insertSpace: () => {} })
  actions.current = {
    start: () => {
      if (!available || latest.current.disabled || document.activeElement !== input.current) return
      const element = input.current
      if (!element) return
      const range = { start: element.selectionStart ?? element.value.length, end: element.selectionEnd ?? element.value.length, value: latest.current.value }
      const notice = capture()
      void speechInput.start(owner, text => insert(text, owner, range), async signal => {
        const response = await window.electronAPI.getSpeechPermission()
        if (!notice.isCurrent() || signal.aborted) return false
        if (!response.success) throw responseError(response, 'speech')
        const permission = speechPermissionSchema.parse(response.data?.permission)
        if (permission !== 'prompt') return undefined
        return feedback.ask({ message: '允许使用麦克风进行语音输入？语音将在本机识别。', actionLabel: '允许', key: 'speech-consent', signal })
      })
    },
    stop: () => { void speechInput.stop(owner) },
    cancel: () => speechInput.cancel(owner),
    insertSpace: () => insert(' ', owner),
  }
  const gesture = useRef<SpaceHold | null>(null)
  gesture.current ??= new SpaceHold({
    start: () => actions.current.start(), stop: () => actions.current.stop(),
    cancel: () => actions.current.cancel(), insertSpace: () => actions.current.insertSpace(),
  })

  useEffect(() => {
    const hold = gesture.current!
    const cancel = () => { hold.reset(); speechInput.cancel(owner) }
    const up = (event: globalThis.KeyboardEvent) => { if (hold.up(event.code)) event.preventDefault() }
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && speechInput.getSnapshot().owner === owner && speechInput.getSnapshot().phase !== 'idle') {
        event.preventDefault()
        cancel()
      }
    }
    const visibility = () => { if (document.hidden) cancel() }
    window.addEventListener('keyup', up)
    window.addEventListener('keydown', escape, true)
    window.addEventListener('blur', cancel)
    window.addEventListener('beforeunload', cancel)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      cancel()
      window.removeEventListener('keyup', up)
      window.removeEventListener('keydown', escape, true)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('beforeunload', cancel)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [owner])

  useEffect(() => {
    if (options.disabled) { gesture.current?.reset(); speechInput.cancel(owner) }
  }, [options.disabled, owner])

  const onKeyDown = (event: KeyboardEvent<T>): void => {
    if (!available || latest.current.disabled || (busy && !active)) return
    if (event.key === 'Escape') { gesture.current!.reset(); return }
    if (active) {
      if (event.code === 'Space' && !composing.current && !event.nativeEvent.isComposing) event.preventDefault()
      return
    }
    if (gesture.current!.down({ code: event.code, repeat: event.repeat, isComposing: composing.current || event.nativeEvent.isComposing || event.keyCode === 229,
      ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey })) event.preventDefault()
  }
  const onBlur = (event: FocusEvent<T>): void => {
    gesture.current!.reset()
    const next = event.relatedTarget
    if (next instanceof Element && next.closest('.feedback-dialog')) return
    if (!(next instanceof Element) || next.closest('[data-speech-owner]')?.getAttribute('data-speech-owner') !== owner) speechInput.cancel(owner)
  }

  return {
    owner, busy, active, available, phase: owns ? snapshot.phase : 'idle', seconds: owns ? snapshot.seconds : 0,
    isComposing: () => composing.current,
    start: () => {
      input.current?.focus()
      actions.current.start()
    },
    stop: actions.current.stop,
    cancel: () => { gesture.current!.reset(); speechInput.cancel(owner) },
    inputProps: {
      ref: input,
      readOnly: active,
      onKeyDown,
      onBlur,
      onPointerDown: () => gesture.current!.flush(),
      onCompositionStart: () => { gesture.current!.flush(); composing.current = true },
      onCompositionEnd: () => { composing.current = false },
    },
  }
}

export type SpeechInputBinding = Omit<ReturnType<typeof useSpeechInput>, 'inputProps'>
