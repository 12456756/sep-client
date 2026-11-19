import type { KnowledgeData } from './knowledge-contracts'

export function knowledgeDegradationMessage(result: Pick<KnowledgeData<'search'>, 'degraded' | 'degradationReason' | 'actualStrategy'>): string | null {
  if (!result.degraded) return null
  const reason = result.degradationReason === 'QUERY_EMBEDDING_UNAVAILABLE' ? '向量检索暂不可用' : '部分检索能力暂不可用'
  return `${reason}${result.actualStrategy === 'LEXICAL' ? '，本次使用关键词检索' : ''}，结果覆盖能力可能受限。`
}
