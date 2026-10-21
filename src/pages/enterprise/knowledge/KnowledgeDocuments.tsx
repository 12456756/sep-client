import { FileText, RefreshCw, Upload, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { KnowledgeBase, KnowledgeDocument } from '../../../shared/knowledge-contracts'
import { knowledgeFileSchema } from '../../../shared/knowledge-contracts'
import { canManageKnowledge, documentName, documentPresentation, isKnowledgeCancelled, KnowledgeClientError, type KnowledgeClient } from '../../../features/knowledge/knowledge-client'
import { useKnowledgeMutation, useKnowledgeQuery } from '../../../features/knowledge/use-knowledge'
import { useKnowledgeDocuments } from '../../../features/knowledge/use-knowledge-documents'
import { KnowledgeDialog, KnowledgeErrorNotice, KnowledgePager } from './KnowledgeUI'

export function KnowledgeDocuments({ client, base }: { client: KnowledgeClient; base: KnowledgeBase }) {
  const [revision, refresh] = useState(0)
  const [selected, setSelected] = useState<KnowledgeDocument | null>(null)
  const [operation, setOperation] = useState<{ action: 'retryDocument' | 'deleteDocument'; doc: KnowledgeDocument; etag: string; key: string } | null>(null)
  const [replacement, setReplacement] = useState<KnowledgeDocument | null>(null)
  const mutation = useKnowledgeMutation()
  const docs = useKnowledgeDocuments(client, base.id, revision)
  const manage = canManageKnowledge(base.permissions, 'upload')
  async function confirmOperation(action: 'retryDocument' | 'deleteDocument', doc: KnowledgeDocument): Promise<void> {
    await mutation.perform(async () => {
      const latest = await client.run({ action: 'getDocument', kbId: base.id, docId: doc.id })
      if (!latest.etag) throw new KnowledgeClientError({ message: '平台未返回文档版本标识，请刷新后重试。' })
      setOperation({ action, doc: latest, etag: latest.etag, key: crypto.randomUUID() })
    })
  }
  return <section className="kb-section" aria-label="文档管理">
    <div className="kb-toolbar"><div><h2>文档</h2><p>支持 PDF、DOCX、TXT、MD，每个文件不超过 10 MiB。扫描件与 OCR 暂不支持。</p></div><button className="ent-btn" onClick={() => refresh(value => value + 1)}><RefreshCw size={15} />刷新状态</button></div>
    {manage ? <KnowledgeUploads key={replacement?.id ?? 'upload'} client={client} kbId={base.id} replacement={replacement} onUploaded={() => refresh(value => value + 1)} onCloseReplacement={() => setReplacement(null)} /> : null}
    <KnowledgeErrorNotice error={docs.error || mutation.error} onRetry={() => refresh(value => value + 1)} />
    {docs.expired ? <p className="kb-info">已停止自动查询。平台可能仍在处理，请刷新查看最新状态。</p> : null}
    {docs.loading ? <p role="status">正在加载文档…</p> : !docs.error && !docs.data.length ? <div className="kb-empty"><FileText size={30} /><h3>知识库中还没有文档</h3><p>{manage ? '上传企业资料后即可建立检索索引。' : '等待管理员上传资料。'}</p></div> : null}
    <div className="kb-doc-list">{docs.data.map(doc => {
      const state = documentPresentation(doc)
      return <article key={doc.id} className="kb-doc-row"><FileText size={22} /><div className="kb-doc-main"><button className="kb-text-button" onClick={() => setSelected(doc)}>{documentName(doc)}</button><div className="kb-badges"><span className={state.processing ? 'kb-badge busy' : doc.latestVersion?.status === 'FAILED' || doc.status === 'FAILED' ? 'kb-badge failed' : 'kb-badge'}>{state.label}</span><span>{state.availability}</span></div>
        {doc.latestVersion?.errorMessage || doc.errorMessage ? <p className="kb-document-error">{doc.latestVersion?.errorMessage ?? doc.errorMessage}</p> : null}
      </div><div className="kb-actions"><button className="ent-btn sm" onClick={() => setSelected(doc)}>查看</button>{manage ? <>
        <button className="ent-btn sm" disabled={mutation.busy || state.processing} onClick={() => setReplacement(doc)}>替换版本</button>
        {state.retryable ? <button className="ent-btn sm" disabled={mutation.busy} onClick={() => void confirmOperation('retryDocument', doc)}>重试处理</button> : null}
        <button className="ent-btn sm kb-danger" disabled={mutation.busy} onClick={() => void confirmOperation('deleteDocument', doc)}>删除</button>
      </> : null}</div></article>
    })}</div>
    {selected ? <KnowledgeDocumentDetail client={client} kbId={base.id} docId={selected.id} name={documentName(selected)} onClose={() => setSelected(null)} /> : null}
    {operation ? <KnowledgeDialog title={operation.action === 'deleteDocument' ? '删除文档' : '重试文档处理'} description={documentName(operation.doc)} busy={mutation.busy} onClose={() => setOperation(null)}>
      <p>{operation.action === 'deleteDocument' ? '删除后将无法继续检索此文档；原件清理可能异步完成。' : '平台将重新处理这个失败版本，现有生效版本继续保留。'}</p>
      <KnowledgeErrorNotice error={mutation.error} />
      <footer><button className="ent-btn" disabled={mutation.busy} onClick={() => setOperation(null)}>取消</button><button className="ent-btn primary" disabled={mutation.busy} onClick={() => void mutation.perform(async () => {
        try {
          await client.run({ action: operation.action, kbId: base.id, docId: operation.doc.id, etag: operation.etag, idempotencyKey: operation.key })
          setOperation(null); refresh(value => value + 1)
        } catch (error) {
          if (error instanceof KnowledgeClientError && [403, 404, 409, 412, 428].includes(error.detail.statusCode ?? 0)) { setOperation(null); refresh(value => value + 1) }
          throw error
        }
      })}>{mutation.busy ? '正在提交…' : '确认'}</button></footer>
    </KnowledgeDialog> : null}
  </section>
}

type UploadItem = { id: string; file: File; key: string; etag?: string; status: 'queued' | 'uploading' | 'accepted' | 'failed' | 'cancelled'; error?: unknown }
function KnowledgeUploads({ client, kbId, replacement, onUploaded, onCloseReplacement }: { client: KnowledgeClient; kbId: string; replacement: KnowledgeDocument | null; onUploaded(): void; onCloseReplacement(): void }) {
  const [queue, setQueue] = useState<UploadItem[]>([])
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  const stopped = useRef(false)
  const working = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  const group = useRef('upload-' + crypto.randomUUID()).current
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; stopped.current = true; client.cancelGroup(group) } }, [client, group])
  const update = (id: string, patch: Partial<UploadItem>): void => { if (mounted.current) setQueue(items => items.map(item => item.id === id ? { ...item, ...patch } : item)) }
  async function upload(items: UploadItem[]): Promise<void> {
    if (working.current) return
    working.current = true; stopped.current = false; setBusy(true)
    try {
      for (const item of items) {
        if (stopped.current || !mounted.current) break
        update(item.id, { status: 'uploading', error: undefined })
        try {
          if (item.file.size === 0 || item.file.size > 10 * 1024 * 1024) throw new KnowledgeClientError({ message: '文件必须大于 0 且不超过 10 MiB。' })
          const file = { filename: item.file.name, bytes: new Uint8Array(await item.file.arrayBuffer()) }
          if (!knowledgeFileSchema.safeParse(file).success) throw new KnowledgeClientError({ message: '文件格式或名称不受支持，仅支持 PDF、DOCX、TXT、MD。' })
          if (stopped.current || !mounted.current) break
          if (replacement && !item.etag) {
            const latest = await client.run({ action: 'getDocument', kbId, docId: replacement.id }, group)
            if (!latest.etag) throw new KnowledgeClientError({ message: '缺少文档版本信息，请刷新后重试。' })
            item.etag = latest.etag; update(item.id, { etag: item.etag })
          }
          if (stopped.current || !mounted.current) break
          await client.run(replacement ? { action: 'replaceDocument', kbId, docId: replacement.id, etag: item.etag!, idempotencyKey: item.key, file }
            : { action: 'uploadDocument', kbId, idempotencyKey: item.key, file }, group)
          update(item.id, { status: 'accepted' }); if (mounted.current) onUploaded()
        } catch (error) {
          update(item.id, { status: isKnowledgeCancelled(error) ? 'cancelled' : 'failed', error })
          if (error instanceof KnowledgeClientError && [401, 403, 404].includes(error.detail.statusCode ?? 0)) break
        }
      }
    } finally {
      working.current = false
      if (mounted.current) { setBusy(false); setQueue(current => current.map(item => item.status === 'uploading' || item.status === 'queued' ? { ...item, status: 'cancelled' } : item)) }
    }
  }
  return <div className="kb-upload-panel">
    <div className="kb-toolbar"><div><strong>{replacement ? `替换：${documentName(replacement)}` : '上传企业资料'}</strong><p>{replacement ? '提交前会读取最新版本信息；新版成功后生效，期间旧版本继续可用。' : '文件会上传到平台。多个文件按顺序逐个处理上传。'}</p></div><div className="kb-actions">
      <input ref={input} type="file" accept=".pdf,.docx,.txt,.md" multiple={!replacement} hidden onChange={event => {
        const files = [...(event.target.files ?? [])]
        const items = files.map(file => ({ id: crypto.randomUUID(), key: crypto.randomUUID(), file, status: 'queued' as const }))
        setQueue(items); event.target.value = ''; void upload(items)
      }} />
      <button className="ent-btn primary" disabled={busy} onClick={() => input.current?.click()}><Upload size={15} />{replacement ? '选择新版本文件' : '选择文件上传'}</button>
      {busy ? <button className="ent-btn" onClick={() => { stopped.current = true; client.cancelGroup(group) }}>停止上传</button> : replacement ? <button className="ent-btn" onClick={onCloseReplacement}>返回上传</button> : null}
    </div></div>
    {queue.length ? <p className="kb-caption">停止请求不代表平台停止处理。结果未确认时，使用下方重试按钮可复用原操作标识。</p> : null}
    {queue.map(item => <div key={item.id} className="kb-upload-item"><div><strong>{item.file.name}</strong><span>{({ queued: '等待上传', uploading: '正在上传或等待平台响应', accepted: '已接收，等待平台处理', failed: '上传结果未确认或失败', cancelled: '已停止，请刷新确认是否接收' })[item.status]}</span><KnowledgeErrorNotice error={item.error} /></div>
      {(item.status === 'failed' || item.status === 'cancelled') ? <button className="ent-btn sm" disabled={busy} onClick={() => {
        const conflict = item.error instanceof KnowledgeClientError && [409, 412, 428].includes(item.error.detail.statusCode ?? 0)
        if (conflict) {
          if (!window.confirm('文档状态已变化。确认重新获取当前版本信息，并将此文件作为新操作提交？')) return
          item.key = crypto.randomUUID(); item.etag = undefined
          update(item.id, { key: item.key, etag: undefined })
        }
        void upload([item])
      }}>重试上传</button> : null}</div>)}
  </div>
}

function KnowledgeDocumentDetail({ client, kbId, docId, name, onClose }: { client: KnowledgeClient; kbId: string; docId: string; name: string; onClose(): void }) {
  const [revision, refresh] = useState(0)
  const [versionId, setVersionId] = useState<string | undefined>()
  const [page, setPage] = useState(1)
  const doc = useKnowledgeQuery(client, { action: 'getDocument', kbId, docId }, revision)
  const versions = useKnowledgeQuery(client, { action: 'versions', kbId, docId }, revision)
  const previewVersion = versionId ?? doc.data?.activeVersion?.id
  const preview = useKnowledgeQuery(client, doc.data && (doc.data.searchable || previewVersion) ? { action: 'preview', kbId, docId, page, pageSize: 20, ...(previewVersion ? { versionId: previewVersion } : {}) } : null, revision)
  useEffect(() => { if (!versionId && preview.data) setVersionId(preview.data.versionId) }, [preview.data, versionId])
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}><Dialog.Portal><Dialog.Overlay className="kb-overlay" /><Dialog.Content className="kb-document-drawer">
    <header><div><Dialog.Title>{name}</Dialog.Title><Dialog.Description>解析内容预览与文档版本；不提供原件下载。</Dialog.Description></div><Dialog.Close className="ent-icon-btn" aria-label="关闭文档详情"><X size={20} /></Dialog.Close></header>
    <KnowledgeErrorNotice error={doc.error || versions.error} onRetry={() => refresh(value => value + 1)} />
    {doc.data ? <div className="kb-badges"><span>{documentPresentation(doc.data).label}</span><span>{documentPresentation(doc.data).availability}</span></div> : null}
    <div className="kb-version-list"><h3>版本历史</h3>{versions.loading ? <p role="status">正在加载版本…</p> : null}{versions.data?.map(version => <button key={version.id} className={`ent-btn sm${previewVersion === version.id ? ' primary' : ''}`} disabled={version.status !== 'READY'} onClick={() => { setVersionId(version.id); setPage(1) }}>
      版本 {version.versionNumber ?? version.version ?? version.id.slice(-8)} · {({ READY: '已就绪', FAILED: '失败', PENDING: '排队中', PROCESSING: '处理中' })[version.status]}{version.id === doc.data?.activeVersion?.id ? '（当前生效）' : ''}
    </button>)}</div>
    <div className="kb-toolbar"><h3>内容预览{previewVersion && doc.data?.activeVersion?.id && previewVersion !== doc.data.activeVersion.id ? ' · 历史版本' : ''}</h3><button className="ent-btn sm" onClick={() => { setPage(1); setVersionId(undefined); refresh(value => value + 1) }}>重新打开第一页</button></div>
    <KnowledgeErrorNotice error={preview.error} />
    {preview.loading ? <p role="status">正在读取解析内容…</p> : null}
    {!doc.loading && doc.data && !doc.data.searchable && !previewVersion ? <p className="kb-info">文档暂未就绪，处理完成后可以预览。</p> : null}
    <div className="kb-preview">{preview.data?.items.map((item, index) => <article key={item.chunkId ?? item.id ?? index}>{item.location?.pageStart != null ? <small>第 {item.location.pageStart} 页</small> : null}<p>{item.content}</p></article>)}</div>
    {preview.data ? <KnowledgePager page={page} total={preview.data.total} pageSize={20} disabled={preview.loading} onChange={setPage} /> : null}
  </Dialog.Content></Dialog.Portal></Dialog.Root>
}
