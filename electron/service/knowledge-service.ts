import { knowledgeRequestSchema, type KnowledgeData, type KnowledgeRequest } from '../../src/shared/knowledge-contracts'
import { KnowledgeApiError, type KnowledgeApiPort } from '../common/platform/knowledge-api'
import { AppError } from '../errors/app-error'
import { requireScope, type ScopeSource } from './scope-guard'

interface Options { scope: ScopeSource; api: KnowledgeApiPort; onAuthenticationRequired?: () => void }
export class KnowledgeService {
  private readonly active = new Map<string, AbortController>()
  private generation = 0
  constructor(private readonly options: Options) {}

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
      const result = await this.options.api.execute(request, signal)
      if (!sameOwner()) throw new AppError('AUTH_REQUIRED')
      signal.throwIfAborted()
      return result as KnowledgeData<R['action']>
    } catch (error) {
      if (error instanceof KnowledgeApiError && error.statusCode === 401 && sameOwner() && !control.signal.aborted) this.options.onAuthenticationRequired?.()
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
