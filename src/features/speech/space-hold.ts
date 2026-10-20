interface Key {
  code: string
  repeat?: boolean
  isComposing?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

interface Actions {
  insertSpace(): void
  start(): void
  stop(): void
  cancel(): void
  schedule?: (callback: () => void) => () => void
}

export class SpaceHold {
  private state: 'idle' | 'pending' | 'recording' = 'idle'
  private clearTimer: (() => void) | undefined

  constructor(private readonly actions: Actions) {}

  down(key: Key): boolean {
    if (key.isComposing || key.ctrlKey || key.metaKey || key.altKey || key.shiftKey) {
      this.flush()
      return false
    }
    if (key.code !== 'Space') { this.flush(); return false }
    if (key.repeat || this.state !== 'idle') return true
    this.state = 'pending'
    const callback = () => {
      if (this.state !== 'pending') return
      this.state = 'recording'
      this.actions.start()
    }
    this.clearTimer = this.actions.schedule ? this.actions.schedule(callback) : (() => {
      const timer = setTimeout(callback, 400)
      return () => clearTimeout(timer)
    })()
    return true
  }

  up(code: string): boolean {
    if (code !== 'Space' || this.state === 'idle') return false
    if (this.state === 'recording') {
      this.clearTimer?.()
      this.state = 'idle'
      this.actions.stop()
    } else this.flush()
    return true
  }

  flush(): void {
    if (this.state !== 'pending') return
    this.clearTimer?.()
    this.state = 'idle'
    this.actions.insertSpace()
  }

  reset(): void {
    this.clearTimer?.()
    if (this.state === 'recording') this.actions.cancel()
    this.state = 'idle'
  }
}
