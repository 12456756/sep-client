import type { ConnectorAssetStore } from '../data/connector-asset-store'
import type { ConnectorDependencyPort, DependencyProgress } from '../domain/connector-dependencies'

export const CONNECTOR_ASSET_ORIGIN = 'https://sep.longdaoec.com/sep-client/stable/connector-assets/'

interface Work {
  controller: AbortController
  promise: Promise<void>
  listeners: Set<(value: DependencyProgress) => void>
  progress?: DependencyProgress
}

/** One download per component, with cancellation scoped to its remaining consumers. */
export class ConnectorDependencies implements ConnectorDependencyPort {
  private work?: Work
  constructor(private readonly store: ConnectorAssetStore, private readonly request: typeof fetch = fetch) {}
  async ensure(signal: AbortSignal, progress: (value: DependencyProgress) => void): Promise<void> {
    signal.throwIfAborted()
    if (!this.work || this.work.controller.signal.aborted) {
      const work: Work = { controller: new AbortController(), promise: Promise.resolve(), listeners: new Set() }
      this.work = work
      work.promise = this.prepare(work).finally(() => { if (this.work === work) this.work = undefined })
    }
    const work = this.work
    const listener = (value: DependencyProgress): void => { if (!signal.aborted) progress(value) }
    work.listeners.add(listener)
    try {
      if (work.progress) listener(work.progress)
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => { signal.removeEventListener('abort', abort); reject(new Error('Connector preparation cancelled')) }
        signal.addEventListener('abort', abort, { once: true })
        void work.promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
        if (signal.aborted) abort()
      })
      signal.throwIfAborted()
    } finally {
      work.listeners.delete(listener)
      if (!work.listeners.size) work.controller.abort()
    }
  }
  private async prepare(work: Work): Promise<void> {
    const { component } = this.store
    const signal = AbortSignal.any([work.controller.signal, AbortSignal.timeout(300000)])
    if (await this.store.ready()) return
    signal.throwIfAborted()
    const notify = (phase: DependencyProgress['phase'], received: number): void => {
      work.progress = { phase, received, total: component.bytes }
      for (const listener of work.listeners) listener(work.progress)
    }
    notify('downloading', 0)
    const response = await this.request(new URL(component.archive, CONNECTOR_ASSET_ORIGIN), { signal, redirect: 'error', credentials: 'omit' })
    if (!response.ok || !response.body) throw new Error('Connector download unavailable')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        signal.throwIfAborted()
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.length
        if (size > component.bytes) throw new Error('Connector download exceeds manifest size')
        chunks.push(chunk.value)
        notify('downloading', size)
      }
    } finally { await reader.cancel().catch(() => {}) }
    if (size !== component.bytes) throw new Error('Incomplete connector download')
    notify('verifying', size)
    await this.store.install(Buffer.concat(chunks, size), signal)
  }
}
