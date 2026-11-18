import { buildContextEntries, buildSessionContext, calculateContextTokens, estimateTokens, migrateSessionEntries, parseSessionEntries } from '@earendil-works/pi-coding-agent'
import type { ContextUsage } from '../../../src/shared/context-usage'

export const GATEWAY_CONTEXT_WINDOW = 128_000

/** Match the SDK estimate without opening a writable session or starting tools. */
export function sessionContextUsage(content: string, sessionId: string): ContextUsage | null {
  const fileEntries = parseSessionEntries(content)
  if (fileEntries[0]?.type !== 'session' || fileEntries[0].id !== sessionId) return null
  migrateSessionEntries(fileEntries)
  const entries = fileEntries.filter(entry => entry.type !== 'session')
  const messages = buildSessionContext(entries).messages
  let trailingTokens = 0
  // Kept messages precede the compaction marker in storage but follow its summary in context.
  // Their old usage must not be used until a later response supplies fresh accounting.
  const contextEntries = buildContextEntries(entries)
  const activeIds = new Set(contextEntries.map(entry => entry.id))
  const compaction = contextEntries.find(entry => entry.type === 'compaction')
  const compactionIndex = compaction ? entries.indexOf(compaction) : -1
  const hasFreshUsage = entries.slice(compactionIndex + 1).some(entry => activeIds.has(entry.id) && entry.type === 'message' &&
    entry.message.role === 'assistant' && entry.message.stopReason !== 'aborted' && entry.message.stopReason !== 'error' &&
    calculateContextTokens(entry.message.usage) > 0)
  if (compaction && !hasFreshUsage) return { tokens: null, contextWindow: GATEWAY_CONTEXT_WINDOW, percent: null }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role === 'assistant' && message.stopReason !== 'aborted' && message.stopReason !== 'error') {
      const usage = calculateContextTokens(message.usage)
      if (usage > 0) return result(usage + trailingTokens)
    }
    trailingTokens += estimateTokens(message)
  }
  return result(trailingTokens)
}

function result(tokens: number): ContextUsage {
  return { tokens, contextWindow: GATEWAY_CONTEXT_WINDOW, percent: tokens / GATEWAY_CONTEXT_WINDOW * 100 }
}
