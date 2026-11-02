import type { TaskExecutionEvent } from './types'

/** Keep tool commentary visible until the next assistant response starts. */
export class RunResponseBuffer {
  private readonly text = new Map<string, string>()
  private readonly fallback = new Map<string, string>()
  private readonly boundaries = new Set<string>()

  append(runId: string, delta: string): void {
    if (!delta) return
    const prior = this.boundaries.delete(runId) ? '' : this.text.get(runId) ?? ''
    this.text.set(runId, prior + delta)
  }

  markToolBoundary(runId: string): void {
    const current = this.text.get(runId)
    if (current) this.fallback.set(runId, current)
    this.boundaries.add(runId)
  }
  get(runId: string): string | undefined { return this.text.get(runId) || this.fallback.get(runId) }
  keys(): IterableIterator<string> { return new Set([...this.text.keys(), ...this.boundaries]).keys() }
  delete(runId: string): void { this.text.delete(runId); this.fallback.delete(runId); this.boundaries.delete(runId) }
  clear(): void { this.text.clear(); this.fallback.clear(); this.boundaries.clear() }
}

export function finalResponseFromEvents(events: readonly TaskExecutionEvent[]): string {
  const buffer = new RunResponseBuffer()
  for (const event of events) {
    if (event.type === 'tool_execution_start') buffer.markToolBoundary('response')
    if (event.type === 'text_delta') {
      const data = event.data as { text?: unknown } | null
      if (typeof data?.text === 'string') buffer.append('response', data.text)
    }
  }
  return buffer.get('response') ?? ''
}
