import { knowledgeRequestSchema, type KnowledgeData, type KnowledgeRequest } from '../../src/shared/knowledge-contracts'
import { KnowledgeApiError, type KnowledgeApiPort } from '../common/platform/knowledge-api'
import { AppError } from '../errors/app-error'
import { requireScope, type ScopeSource } from './scope-guard'
import { randomUUID } from 'node:crypto'
import { knowledgeSelectionSchema } from '../../src/shared/knowledge-selection'
import type { KnowledgeSearchRequest } from '../common/knowledge-context'

interface Options { scope: ScopeSource; api: KnowledgeApiPort; onAuthenticationRequired?: () => void }
export class KnowledgeService {
  private readonly active = new Map<string, AbortController>()
  private generation = 0
  constructor(private readonly options: Options) {}

  async searchForRuntime(input: KnowledgeSearchRequest, signal?: AbortSignal): Promise<KnowledgeData<'search'>> {
    const selection = knowledgeSelectionSchema.parse({ mode: input.sources?.length ? 'manual' : 'auto', knowledgeBaseIds: input.knowledgeBaseIds,
      ...(input.sources?.length ? { sources: input.sources } : {}) })
    const owner = requireScope(this.options.scope)
    const generation = this.generation
    const assertOwner = (): void => {
      const current = requireScope(this.options.scope)
      if (generation !== this.generation || current.memberId !== owner.memberId || current.enterpriseId !== owner.enterpriseId) throw new AppError('AUTH_REQUIRED')
      signal?.throwIfAborted()
    }
    assertOwner()
    if (!selection.sources?.length) {
      const result = await this.execute({ requestId: randomUUID(), action: 'search', query: input.query, knowledgeBaseIds: selection.knowledgeBaseIds, topK: input.topK ?? 5 }, signal)
      assertOwner()
      if (result.results.some(item => !selection.knowledgeBaseIds.includes(item.knowledgeBaseId))) throw new KnowledgeApiError(502, 'INVALID_RESPONSE')
      return result
    }
    const start = Date.now()
    const names = new Map<string, string>()
    // Validate the entire chosen scope, including libraries without a cited fragment.
    for (const id of selection.knowledgeBaseIds) {
      assertOwner()
      const base = await this.execute({ requestId: randomUUID(), action: 'getBase', kbId: id }, signal)
      assertOwner()
      if (base.id !== id) throw new KnowledgeApiError(502, 'INVALID_RESPONSE')
      names.set(id, base.name)
    }
    const results: KnowledgeData<'search'>['results'] = []
    for (const ref of selection.sources) {
      assertOwner()
      const source = await this.execute({ requestId: randomUUID(), action: 'source', kbId: ref.knowledgeBaseId, sourceId: ref.sourceId }, signal)
      assertOwner()
      if (source.sourceId !== ref.sourceId || source.knowledgeBaseId !== ref.knowledgeBaseId) throw new KnowledgeApiError(502, 'INVALID_RESPONSE')
      results.push({ ...source, knowledgeBaseName: names.get(ref.knowledgeBaseId)! })
    }
    return { status: 'MATCHED', results, actualStrategy: 'MANUAL', degraded: false, partial: false, durationMs: Date.now() - start }
  }

  async describeForRuntime(ids: string[], signal?: AbortSignal): Promise<Array<{ id: string; name: string }>> {
    const selection = knowledgeSelectionSchema.parse({ mode: 'auto', knowledgeBaseIds: ids })
    const owner = requireScope(this.options.scope)
    const generation = this.generation
    const bases: Array<{ id: string; name: string }> = []
    for (const id of selection.knowledgeBaseIds) {
      const current = requireScope(this.options.scope)
      if (generation !== this.generation || current.memberId !== owner.memberId || current.enterpriseId !== owner.enterpriseId) throw new AppError('AUTH_REQUIRED')
      const base = await this.execute({ requestId: randomUUID(), action: 'getBase', kbId: id }, signal)
      if (base.id !== id) throw new KnowledgeApiError(502, 'INVALID_RESPONSE')
      bases.push({ id, name: base.name })
    }
    return bases
  }

  async execute<R extends KnowledgeRequest>(input: R, externalSignal?: AbortSignal): Promise<KnowledgeData<R['action']>> {
    const request = knowledgeRequestSchema.parse(input)
    const owner = requireScope(this.options.scope)
    const generation = this.generation
    if (this.active.has(request.requestId)) throw new AppError('CONFLICT', { message: '请求正在进行，请等待或取消后重试。' })
    if (this.active.size >= 16) throw new AppError('RATE_LIMITED')
    const control = new AbortController()
    this.active.set(request.requestId, control)
    const signal = externalSignal ? AbortSignal.any([control.signal, externalSignal]) : control.signal
    const sameOwner = (): boolean => {
      const current = this.options.scope.currentScope()
      return generation === this.generation && current?.memberId === owner.memberId && current.enterpriseId === owner.enterpriseId
    }
    try {
      if (signal.aborted) throw new KnowledgeApiError(499)
      const result = await this.options.api.execute(request, signal)
      if (!sameOwner()) throw new AppError('AUTH_REQUIRED')
      signal.throwIfAborted()
      return result as KnowledgeData<R['action']>
    } catch (error) {
      if (signal.aborted) throw new KnowledgeApiError(499)
      if (error instanceof KnowledgeApiError && error.statusCode === 401 && sameOwner()) this.options.onAuthenticationRequired?.()
      throw error
    } finally { this.active.delete(request.requestId) }
  }
  cancel(requestIds: readonly string[]): void {
    for (const id of requestIds) this.active.get(id)?.abort()
  }
  clear(): void {
    this.generation++
    for (const controller of this.active.values()) controller.abort()
    // Entries are released in their owners' finally blocks, preventing duplicate-ID races.
  }
}
