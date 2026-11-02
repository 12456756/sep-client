import { ArrowLeft, BookOpen, FileText, Plus, RefreshCw, Settings, Users } from 'lucide-react'
import { useState } from 'react'
import type { AppRoute } from '../../../features/enterprise/types'
import { canManageKnowledge, KnowledgeClientError, type KnowledgeClient } from '../../../features/knowledge/knowledge-client'
import { useKnowledgeClient, useKnowledgeMutation, useKnowledgeQuery } from '../../../features/knowledge/use-knowledge'
import type { KnowledgeBase } from '../../../shared/knowledge-contracts'
import { KnowledgeDialog, KnowledgeErrorNotice, KnowledgePager, KnowledgeSearchForm } from './KnowledgeUI'
import { KnowledgeDocuments } from './KnowledgeDocuments'
import { KnowledgeGrants } from './KnowledgeGrants'
import '../../../styles/knowledge.css'

export function KnowledgePage({ kbId, navigate }: { kbId?: string; navigate(route: AppRoute): void }) {
  const { client, pending } = useKnowledgeClient()
  return <main className="ent-page kb-page">
    <div className="kb-info">企业资料由平台托管。上传后由平台处理，成员只能访问已获授权的知识库。</div>
    {pending > 0 ? <div className="kb-pending" role="status"><span>正在请求平台，限流时会按平台要求等待…</span><button className="ent-btn sm" onClick={() => client.cancelAll()}>取消请求</button></div> : null}
    {kbId ? <KnowledgeDetail key={kbId} client={client} kbId={kbId} back={() => { client.cancelAll(); navigate({ name: 'knowledge' }) }} />
      : <KnowledgeList client={client} open={id => { client.cancelAll(); navigate({ name: 'knowledge', kbId: id }) }} />}
  </main>
}
function KnowledgeList({ client, open }: { client: KnowledgeClient; open(id: string): void }) {
  const [page, setPage] = useState(1)
  const [keyword, setKeyword] = useState('')
  const [revision, refresh] = useState(0)
  const [creating, setCreating] = useState(false)
  const result = useKnowledgeQuery(client, { action: 'list', page, pageSize: 20, keyword }, revision)
  const capabilities = result.data?.capabilities
  const canCreate = result.data?.viewer.isAdmin === true || capabilities?.canCreateKnowledgeBase === true || capabilities?.canManageKnowledgeBases === true || capabilities?.createKnowledgeBase === true
  return <>
    <header className="kb-toolbar"><KnowledgeSearchForm placeholder="搜索知识库名称" onSearch={value => { setKeyword(value); setPage(1) }} />
      <div className="kb-actions"><button className="ent-btn" onClick={() => refresh(value => value + 1)}><RefreshCw size={15} />刷新</button>{canCreate ? <button className="ent-btn primary" onClick={() => setCreating(true)}><Plus size={15} />新建知识库</button> : null}</div>
    </header>
    <KnowledgeErrorNotice error={result.error} onRetry={() => refresh(value => value + 1)} />
    {result.loading ? <p role="status">正在加载知识库…</p> : null}
    {result.data && !result.data.items.length ? <div className="kb-empty"><BookOpen size={34} /><h2>{keyword ? '没有找到匹配的知识库' : '暂无可访问的知识库'}</h2><p>{canCreate ? '新建知识库并上传企业资料。' : '请联系企业管理员为你授权知识库。'}</p></div> : null}
    <div className="kb-grid">{result.data?.items.map(base => <button className="kb-card" key={base.id} onClick={() => open(base.id)}><span className="kb-card-icon"><BookOpen size={23} /></span><h2>{base.name}</h2><p>{base.description || '暂无说明'}</p><footer><span>{base.documentCount ?? '—'} 份文档</span><span>{base.readyDocumentCount ?? '—'} 份已就绪</span></footer></button>)}</div>
    {result.data ? <KnowledgePager page={result.data.page} pageSize={result.data.pageSize} total={result.data.total} onChange={setPage} disabled={result.loading} /> : null}
    {creating ? <BaseEditor client={client} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); refresh(value => value + 1) }} /> : null}
  </>
}
function KnowledgeDetail({ client, kbId, back }: { client: KnowledgeClient; kbId: string; back(): void }) {
  const [revision, refresh] = useState(0)
  const [tab, setTab] = useState<'documents' | 'grants'>('documents')
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmation, setConfirmation] = useState('')
  const mutation = useKnowledgeMutation()
  const result = useKnowledgeQuery(client, { action: 'getBase', kbId }, revision)
  const base = result.data
  const manage = base ? canManageKnowledge(base.permissions) : false
  const grant = base ? canManageKnowledge(base.permissions, 'grant') : false
  return <>
    <button className="ent-btn ghost" onClick={back}><ArrowLeft size={16} />返回知识库</button>
    <KnowledgeErrorNotice error={result.error} onRetry={() => refresh(value => value + 1)} />
    {result.loading ? <p role="status">正在加载知识库…</p> : null}
    {base ? <>
      <header className="kb-detail-head"><div><h1>{base.name}</h1><p>{base.description || '暂无说明'}</p></div><div className="kb-actions">
        <button className="ent-btn" onClick={() => refresh(value => value + 1)}><RefreshCw size={15} />刷新</button>
        {manage ? <><button className="ent-btn" onClick={() => setEditing(true)}><Settings size={15} />编辑</button><button className="ent-btn kb-danger" onClick={() => { mutation.clearError(); setDeleting(true) }}>删除知识库</button></> : null}
      </div></header>
      <div className="kb-tabs" role="tablist" aria-label="知识库内容">{([
        ['documents', '文档', FileText], ...(grant ? [['grants', '成员授权', Users] as const] : []),
      ] as const).map(([id, label, Icon]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}><Icon size={16} />{label}</button>)}</div>
      {tab === 'documents' ? <KnowledgeDocuments client={client} base={base} /> : null}
      {tab === 'grants' && grant ? <KnowledgeGrants client={client} base={base} /> : null}
      {editing ? <BaseEditor client={client} base={base} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); refresh(value => value + 1) }} /> : null}
      {deleting ? <KnowledgeDialog title="删除知识库" description="删除后成员将无法继续检索该库。已展示或进入历史对话的内容不会自动收回。" onClose={() => setDeleting(false)} busy={mutation.busy}>
        <label className="ent-field"><span>输入“{base.name}”确认删除</span><input className="ent-input" value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
        <KnowledgeErrorNotice error={mutation.error} />
        <footer><button className="ent-btn" disabled={mutation.busy} onClick={() => setDeleting(false)}>取消</button><button className="ent-btn kb-danger" disabled={mutation.busy || confirmation !== base.name} onClick={() => void mutation.perform(async () => { await client.run({ action: 'deleteBase', kbId }); back() })}>确认删除</button></footer>
      </KnowledgeDialog> : null}
    </> : null}
  </>
}
function BaseEditor({ client, base, onClose, onSaved }: { client: KnowledgeClient; base?: KnowledgeBase; onClose(): void; onSaved(): void }) {
  const [name, setName] = useState(base?.name ?? '')
  const [description, setDescription] = useState(base?.description ?? '')
  const [uncertain, setUncertain] = useState(false)
  const mutation = useKnowledgeMutation()
  return <KnowledgeDialog title={base ? '编辑知识库' : '新建知识库'} description="名称用于识别知识库，说明用于介绍资料范围。" onClose={onClose} busy={mutation.busy}>
    <form onSubmit={event => { event.preventDefault(); void mutation.perform(async () => {
      try {
        await client.run(base ? { action: 'updateBase', kbId: base.id, name: name.trim(), description } : { action: 'createBase', name: name.trim(), description })
        onSaved()
      } catch (error) {
        if (!base && error instanceof KnowledgeClientError && [0, 408, 499, 502].includes(error.detail.statusCode ?? 0)) setUncertain(true)
        throw error
      }
    }) }}>
      <label className="ent-field"><span>名称</span><input className="ent-input" required maxLength={100} value={name} onChange={event => setName(event.target.value)} disabled={mutation.busy} /></label>
      <label className="ent-field"><span>说明</span><textarea className="ent-input" rows={4} maxLength={500} value={description} onChange={event => setDescription(event.target.value)} disabled={mutation.busy} /></label>
      <KnowledgeErrorNotice error={mutation.error} />
      {uncertain ? <p className="kb-info">创建结果尚未确认。请关闭弹窗并刷新列表核对，避免重复创建。</p> : null}
      <footer><button type="button" className="ent-btn" disabled={mutation.busy} onClick={onClose}>取消</button><button className="ent-btn primary" disabled={mutation.busy || uncertain || !name.trim()}>{mutation.busy ? '正在保存…' : '保存'}</button></footer>
    </form>
  </KnowledgeDialog>
}
