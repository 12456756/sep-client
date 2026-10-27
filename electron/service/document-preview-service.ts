import { documentPreviewRequestSchema, supportsDocumentPreview, type DocumentPreview, type DocumentPreviewContent, type DocumentPreviewRequest } from '../../src/shared/document-preview'
import type { FinalDeliveryFile } from '../domain/arrangement-delivery'
import type { TaskOwnerScope } from '../data/scope-path'
import { AppError } from '../errors/app-error'
import { requireScope, type ScopeSource } from './scope-guard'

interface Options {
  scope: ScopeSource
  getDelivery(scope: TaskOwnerScope, taskId: string, nodeId: string, deliverableId: string): Promise<{ status: string; file: FinalDeliveryFile; workspace: string } | null>
  read(scope: TaskOwnerScope, taskId: string, file: FinalDeliveryFile, workspace: string): Promise<{ bytes: Uint8Array; source: DocumentPreview['source'] }>
  readConversation?(scope: TaskOwnerScope, taskId: string, fileId: string): Promise<{ name: string; format: string; version: string; bytes: Uint8Array } | null>
  render(format: string, bytes: Uint8Array, validate: () => void): Promise<DocumentPreviewContent>
  stop?: () => void
}

const version = (file: FinalDeliveryFile) => file.snapshot?.sha256 ?? file.sha256
const CACHE_BYTES = 32 * 1024 * 1024

export class DocumentPreviewService {
  private epoch = 0
  private cacheBytes = 0
  private readonly cache = new Map<string, { content: DocumentPreviewContent; size: number }>()
  private readonly pending = new Map<string, Promise<DocumentPreviewContent>>()
  constructor(private readonly options: Options) {}

  clear(): void {
    this.epoch++
    this.cache.clear()
    this.cacheBytes = 0
    this.pending.clear()
    this.options.stop?.()
  }

  async preview(raw: DocumentPreviewRequest): Promise<DocumentPreview> {
    const input = documentPreviewRequestSchema.parse(raw)
    const scope = requireScope(this.options.scope), epoch = this.epoch
    const assert = () => {
      const current = requireScope(this.options.scope)
      if (epoch !== this.epoch || current.memberId !== scope.memberId || current.enterpriseId !== scope.enterpriseId) throw new AppError('AUTH_REQUIRED')
    }
    if ('fileId' in input) {
      const read = async () => {
        try {
          const file = await this.options.readConversation?.(scope, input.taskId, input.fileId)
          assert()
          if (!file) throw new AppError('NOT_FOUND', { message: '此文件不在当前对话成果列表中，或暂不支持预览。' })
          if (!supportsDocumentPreview(file.format)) throw new AppError('INVALID_ARGUMENT', { message: '此格式暂不支持文档预览，可复制路径查看原文件。' })
          return file
        } catch (error) {
          assert()
          if (error instanceof AppError) throw error
          throw new AppError('NOT_FOUND', { message: '对话成果暂不可读取，请确认文件已保存、未被删除且位于工作目录内。' })
        }
      }
      const file = await read()
      const key = JSON.stringify([scope, input, file.format, file.version])
      const content = await this.convert(key, file.format, file.bytes, assert)
      const current = await read()
      if (current.version !== file.version || current.name !== file.name || current.format !== file.format) {
        throw new AppError('INVALID_STATE', { message: '对话成果文件已更新，请重新打开预览。' })
      }
      return { name: file.name, format: file.format, version: file.version, source: 'conversation-file', content }
    }
    const delivery = await this.options.getDelivery(scope, input.taskId, input.nodeId, input.deliverableId)
    assert()
    if (!delivery || delivery.status !== 'completed') throw new AppError('NOT_FOUND', { message: '此节点尚无已验收的文档，请等待节点交付完成。' })
    const { file, workspace } = delivery
    if (!supportsDocumentPreview(file.format) || file.sourceArtifact) throw new AppError('INVALID_ARGUMENT', { message: '此格式暂不支持文档预览，可复制路径查看原文件。' })
    let local: Awaited<ReturnType<Options['read']>>
    try { local = await this.options.read(scope, input.taskId, file, workspace) }
    catch { assert(); throw new AppError('NOT_FOUND', { message: '验收版本不可读取或已被修改，可复制路径检查原文件。' }) }
    assert()
    const key = JSON.stringify([scope, input, file.format, version(file)])
    const content = await this.convert(key, file.format, local.bytes, assert)
    const current = await this.options.getDelivery(scope, input.taskId, input.nodeId, input.deliverableId)
    assert()
    if (!current || current.status !== 'completed' || version(current.file) !== version(file) || current.file.nodeRunId !== file.nodeRunId) {
      throw new AppError('INVALID_STATE', { message: '文档交付版本已更新，请重新打开预览。' })
    }
    return { name: file.path.split(/[\\/]/).pop() || file.id, format: file.format, version: version(file), source: local.source, content }
  }

  private async convert(key: string, format: string, bytes: Uint8Array, assert: () => void): Promise<DocumentPreviewContent> {
    let content = this.cache.get(key)?.content
    if (content) {
      const entry = this.cache.get(key)!
      this.cache.delete(key); this.cache.set(key, entry)
    } else {
      let pending = this.pending.get(key)
      if (!pending) {
        pending = format.toLowerCase() === 'pdf'
          ? Promise.resolve({ kind: 'pdf', bytes: new Uint8Array(bytes) })
          : this.options.render(format, bytes, assert)
        this.pending.set(key, pending)
      }
      try { content = await pending }
      finally { if (this.pending.get(key) === pending) this.pending.delete(key) }
      assert()
      if (content.kind !== 'pdf' && !this.cache.has(key)) {
        const size = content.kind === 'html' ? content.sections.reduce((sum, section) => sum + section.html.length * 2, 0) : content.text.length * 2
        if (size <= CACHE_BYTES) {
          while (this.cacheBytes + size > CACHE_BYTES && this.cache.size) {
            const oldest = this.cache.keys().next().value!
            this.cacheBytes -= this.cache.get(oldest)!.size
            this.cache.delete(oldest)
          }
          this.cache.set(key, { content, size }); this.cacheBytes += size
        }
      }
    }
    assert()
    return content
  }
}
