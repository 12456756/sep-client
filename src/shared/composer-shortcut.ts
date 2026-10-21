interface ComposerKeyEvent {
  key: string
  shiftKey: boolean
  repeat: boolean
  defaultPrevented: boolean
  nativeEvent: { isComposing: boolean; keyCode: number }
}

export function isSubmitEnter(event: ComposerKeyEvent, composing = false): boolean {
  return event.key === 'Enter'
    && !event.shiftKey
    && !event.repeat
    && !event.defaultPrevented
    && !composing
    && !event.nativeEvent.isComposing
    && event.nativeEvent.keyCode !== 229
}
