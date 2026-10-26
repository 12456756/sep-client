export interface FeedbackNotice {
  message: string
  tone: 'error' | 'warning' | 'success'
  key?: string
}

export interface FeedbackConfirmation {
  title?: string
  message: string
  actionLabel: string
  busyLabel: string
  key?: string
  onConfirm: () => Promise<{ success: boolean; message: string }>
}

export interface FeedbackItem {
  id: number
  key: string
  message: string
  title?: string
  tone: FeedbackNotice['tone'] | 'confirm'
  busy: boolean
  actionLabel?: string
  busyLabel?: string
}

interface Entry {
  item: FeedbackItem
  confirmation?: FeedbackConfirmation
  resolve?: (accepted: boolean) => void
  promise?: Promise<boolean>
}

export class FeedbackController {
  private queue: Entry[] = []
  private listeners = new Set<() => void>()
  private nextId = 0
  private revision = 0

  getSnapshot = (): FeedbackItem | null => this.queue[0]?.item ?? null
  getRevision = (): number => this.revision
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private emit(): void { this.listeners.forEach(listener => listener()) }

  show = (notice: FeedbackNotice): void => {
    const key = notice.key ?? `${notice.tone}:${notice.message}`
    if (this.queue.some(entry => entry.item.key === key)) return
    this.queue.push({ item: { ...notice, key, id: ++this.nextId, busy: false } })
    this.emit()
  }

  confirm = (confirmation: FeedbackConfirmation): Promise<boolean> => {
    const key = confirmation.key ?? `confirm:${confirmation.message}`
    const existing = this.queue.find(entry => entry.item.key === key)
    if (existing?.promise) return existing.promise
    let resolve!: (accepted: boolean) => void
    const promise = new Promise<boolean>(settle => { resolve = settle })
    this.queue.push({
      item: { id: ++this.nextId, key, message: confirmation.message, title: confirmation.title,
        tone: 'confirm', busy: false, actionLabel: confirmation.actionLabel, busyLabel: confirmation.busyLabel },
      confirmation, promise, resolve,
    })
    this.emit()
    return promise
  }

  dismiss = (id: number): void => {
    const entry = this.queue[0]
    if (!entry || entry.item.id !== id || entry.item.busy) return
    this.queue.shift()
    entry.resolve?.(false)
    this.emit()
  }

  accept = async (id: number): Promise<void> => {
    const entry = this.queue[0]
    if (!entry || entry.item.id !== id || entry.item.busy || !entry.confirmation) return
    entry.item = { ...entry.item, busy: true }
    this.emit()
    let result: { success: boolean; message: string }
    try { result = await entry.confirmation.onConfirm() }
    catch { result = { success: false, message: '操作失败，请联系平台管理员' } }
    // A cleared session owns neither this response nor its confirmation promise.
    if (this.queue[0] !== entry) return
    entry.resolve?.(result.success)
    entry.resolve = undefined
    entry.confirmation = undefined
    entry.item = { id, key: entry.item.key, message: result.message, tone: result.success ? 'success' : 'error', busy: false }
    this.emit()
  }

  clear = (): void => {
    this.revision++
    const previous = this.queue
    this.queue = []
    previous.forEach(entry => entry.resolve?.(false))
    this.emit()
  }
}
