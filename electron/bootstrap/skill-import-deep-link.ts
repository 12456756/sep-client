import type { App } from 'electron'
import { parseSkillImportLink } from '../common/skill-import-link'
import { logger } from '../common/logger'

export type SkillImportLink = { instanceId: string; sessionId: string }

/** Register synchronously, before whenReady, so macOS cold-start URLs cannot be lost. */
export function installSkillImportDeepLinks(application: Pick<App, 'on' | 'removeListener' | 'requestSingleInstanceLock' | 'quit'>,
  options: { argv: readonly string[]; trustedInstances: ReadonlySet<string>; focus(): void }) {
  const queue: SkillImportLink[] = []
  let consume: ((link: SkillImportLink) => Promise<void>) | undefined
  let draining = false
  let disposed = false
  const log = logger.child('skill-import-link')
  const drain = async () => {
    if (draining || !consume || disposed) return
    draining = true
    try {
      while (queue.length && !disposed) {
        const item = queue.shift()!
        try { await consume(item) } catch { log.warn('import activation failed') }
      }
    } finally { draining = false }
  }
  const enqueue = (raw: string) => {
    const link = parseSkillImportLink(raw, options.trustedInstances)
    if (!link || disposed) return
    if (queue.some(item => item.instanceId === link.instanceId && item.sessionId === link.sessionId)) return
    if (queue.length >= 16) { log.warn('import activation queue full'); return }
    queue.push(link)
    void drain()
  }
  const onUrl = (event: { preventDefault(): void }, url: string) => { event.preventDefault(); enqueue(url) }
  const onSecondInstance = (_event: unknown, argv: string[]) => {
    const links = argv.filter(arg => arg.startsWith('sep-import:'))
    if (!links.length) options.focus()
    for (const arg of links) enqueue(arg)
  }
  application.on('open-url', onUrl)
  const primary = application.requestSingleInstanceLock()
  if (!primary) {
    application.removeListener('open-url', onUrl)
    application.quit()
  } else {
    application.on('second-instance', onSecondInstance)
    for (const arg of options.argv) if (arg.startsWith('sep-import:')) enqueue(arg)
  }
  return {
    primary,
    hasPendingLinks(): boolean { return queue.length > 0 },
    attach(handler: (link: SkillImportLink) => Promise<void>): void { consume = handler; void drain() },
    dispose(): void {
      disposed = true
      queue.length = 0
      application.removeListener('open-url', onUrl)
      application.removeListener('second-instance', onSecondInstance)
    },
  }
}
