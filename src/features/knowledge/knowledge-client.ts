import type { ElectronAPI } from '../../shared/ipc'
import type { KnowledgeData, KnowledgeDocument, KnowledgeError, KnowledgeGrant, KnowledgeRequestInput, KnowledgeResult } from '../../shared/knowledge-contracts'

type WithoutId<T> = T extends { requestId: string } ? Omit<T, 'requestId'> : never
export type KnowledgeCommand = WithoutId<KnowledgeRequestInput>
export class KnowledgeClientError extends Error {
  constructor(public readonly detail: KnowledgeError) { super(detail.message); this.name = 'KnowledgeClientError' }
  get cancelled(): boolean { return this.detail.statusCode === 499 }
}
export function isKnowledgeCancelled(error: unknown): boolean { return error instanceof KnowledgeClientError && error.cancelled }
interface Pending { group?: string; cancel(): void }
type KnowledgeTransport = Pick<ElectronAPI, 'requestKnowledge' | 'cancelKnowledgeRequests'>
export class KnowledgeClient {
  private readonly pending = new Map<string, Pending>()
  onChange?: (count: number) => void
  constructor(private readonly api: KnowledgeTransport) {}
  get pendingCount(): number { return this.pending.size }
  async run<R extends KnowledgeCommand>(input: R, group?: string): Promise<KnowledgeData<R['action']>> {
    if (group) this.cancelGroup(group)
    const requestId = crypto.randomUUID()
    let cancel!: () => void
    const cancelled = new Promise<never>((_resolve, reject) => { cancel = () => reject(new KnowledgeClientError({ statusCode: 499, message: '请求已取消。' })) })
    this.pending.set(requestId, { group, cancel })
    this.onChange?.(this.pending.size)
    try {
      const response = await Promise.race([
        this.api.requestKnowledge({ ...input, requestId } as KnowledgeRequestInput), cancelled,
      ]) as KnowledgeResult<R['action']>
      if (!this.pending.has(requestId)) throw new KnowledgeClientError({ statusCode: 499, message: '请求已取消。' })
      if (!response.success) throw new KnowledgeClientError(response.error)
      return response.data
    } finally { this.pending.delete(requestId); this.onChange?.(this.pending.size) }
  }
  cancelGroup(group: string): void { this.cancelWhere(value => value.group === group) }
  cancelAll(): void { this.cancelWhere(() => true) }
  private cancelWhere(matches: (value: Pending) => boolean): void {
    const ids: string[] = []
    for (const [id, value] of this.pending) if (matches(value)) { ids.push(id); this.pending.delete(id); value.cancel() }
    if (ids.length) {
      this.onChange?.(this.pending.size)
      void this.api.cancelKnowledgeRequests(ids).catch(() => undefined)
    }
  }
}
export function canManageKnowledge(permissions: Record<string, boolean>, action: 'manage' | 'upload' | 'grant' = 'manage'): boolean {
  if (permissions.canManage === true || permissions.manage === true) return true
  if (action === 'upload') return permissions.canUpload === true || permissions.canManageDocuments === true || permissions.canUploadDocuments === true
  if (action === 'grant') return permissions.canGrant === true || permissions.canManageGrants === true
  return false
}
export function processingDelay(attempt: number): number { return Math.min(10_000, 2000 * 1.5 ** attempt) }
export function documentName(doc: KnowledgeDocument): string {
  const latest = doc.latestVersion
  return latest?.originalName || latest?.name || latest?.filename || doc.originalName || doc.name || doc.filename || '未命名文档'
}
export function grantMemberId(grant: KnowledgeGrant): string {
  const memberId = grant.memberId ?? grant.member?.memberId
  if (!memberId) throw new Error('知识库授权记录缺少成员标识')
  return memberId
}
export function documentPresentation(doc: KnowledgeDocument): { label: string; availability: string; processing: boolean; retryable: boolean } {
  const latest = doc.latestVersion
  const status = latest?.status ?? doc.status
  const stage = latest?.stage ?? doc.stage
  const stages: Record<string, string> = { QUEUED: '排队中', PARSING: '解析中', CHUNKING: '切分中', EMBEDDING: '建立索引中', PUBLISHING: '发布中', RETRY_WAIT: '等待重试' }
  return {
    label: status === 'FAILED' ? '最新版本处理失败' : status === 'READY' ? '处理完成' : stages[stage ?? ''] ?? '处理中',
    availability: doc.searchable ? latest && doc.activeVersion && latest.id !== doc.activeVersion.id ? '旧版本仍可检索' : '可检索' : '暂不可检索',
    processing: status === 'PENDING' || status === 'PROCESSING',
    retryable: status === 'FAILED' && (latest?.retryable ?? doc.retryable) === true,
  }
}
