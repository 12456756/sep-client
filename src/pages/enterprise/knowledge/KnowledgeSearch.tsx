import { Search } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { restoreKnowledgeFilename, type KnowledgeBase, type KnowledgeData } from '../../../shared/knowledge-contracts'
import { isKnowledgeCancelled, type KnowledgeClient } from '../../../features/knowledge/knowledge-client'
import { KnowledgeErrorNotice } from './KnowledgeUI'

export function KnowledgeSearch({ client, base }: { client: KnowledgeClient; base: KnowledgeBase }) {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState('current')
  const [topK, setTopK] = useState(5)
  const [result, setResult] = useState<KnowledgeData<'search'> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const generation = useRef(0)
  const group = useRef('search-' + crypto.randomUUID()).current
  useEffect(() => () => { generation.current++; client.cancelGroup(group) }, [client, group])
  const reset = (): void => { generation.current++; client.cancelGroup(group); setResult(null); setError(null); setBusy(false) }
  async function search(): Promise<void> {
    const current = ++generation.current
    setBusy(true); setError(null); setResult(null)
    try {
      const response = await client.run({ action: 'search', query: query.trim(), topK, ...(scope === 'current' ? { knowledgeBaseIds: [base.id] } : {}) }, group)
      if (current === generation.current) setResult(response)
    } catch (reason) { if (current === generation.current && !isKnowledgeCancelled(reason)) setError(reason) }
    finally { if (current === generation.current) setBusy(false) }
  }
  return <section className="kb-section" aria-label="知识库检索"><h2>检索企业资料</h2><p>直接查看平台命中的资料片段，验证检索效果。本页不调用模型生成回答。</p>
    <form className="kb-retrieval-form" onSubmit={event => { event.preventDefault(); void search() }}>
      <label className="ent-field"><span>你想查找什么？</span><textarea className="ent-input" rows={3} maxLength={1000} placeholder="例如：差旅住宿报销标准是什么？" value={query} onChange={event => { reset(); setQuery(event.target.value) }} /></label>
      <div className="kb-toolbar"><div className="kb-actions"><label>检索范围 <select className="ent-select" aria-label="检索范围" value={scope} onChange={event => { reset(); setScope(event.target.value) }}><option value="current">当前知识库</option><option value="all">全部可访问知识库</option></select></label><label>结果数量 <select className="ent-select" aria-label="结果数量" value={topK} onChange={event => { reset(); setTopK(Number(event.target.value)) }}>{[5, 10, 20].map(count => <option key={count} value={count}>{count}</option>)}</select></label></div><div className="kb-actions">{busy ? <button className="ent-btn" type="button" onClick={reset}>取消检索</button> : null}<button className="ent-btn primary" disabled={busy || !query.trim()}><Search size={15} />{busy ? '正在检索…' : '检索'}</button></div></div>
    </form>
    <KnowledgeErrorNotice error={error} />
    {result ? <>
      {result.degraded ? <p className="kb-info">向量检索暂不可用，本次使用关键词检索，结果覆盖能力可能受限。</p> : null}
      {result.partial ? <p className="kb-info">部分资料尚未就绪，本次结果仅覆盖已就绪的资料。</p> : null}
      {result.status !== 'MATCHED' ? <div className="kb-empty"><Search size={30} /><h3>{({ NO_MATCH: '没有找到匹配的资料', NO_ACCESS: '暂无可访问的知识库', NOT_READY: '资料尚未就绪' })[result.status]}</h3><p>{result.status === 'NO_MATCH' ? '可以调整问题或补充相关资料。' : result.status === 'NOT_READY' ? '请等待文档处理完成，或联系管理员补充资料。' : '请联系企业管理员授权。'}</p></div> : <>
        <div className="kb-result-summary">找到 {result.results.length} 条相关片段 · {result.actualStrategy} · {result.durationMs} ms</div>
        <div className="kb-results">{result.results.map((item, index) => <article className="kb-result" key={item.sourceId}><header><strong>{index + 1}. {restoreKnowledgeFilename(item.documentName)}</strong><span>{item.knowledgeBaseName}</span></header><div className="kb-caption">版本 {item.versionId}{item.location.pageStart != null ? ` · 第 ${item.location.pageStart}${item.location.pageEnd != null && item.location.pageEnd !== item.location.pageStart ? `–${item.location.pageEnd}` : ''} 页` : ''}{item.location.sectionPath?.length ? ' · ' + item.location.sectionPath.join(' / ') : ''}</div><p>{item.content}</p>{item.truncated ? <small>此片段已按平台预算截取。</small> : null}</article>)}</div>
      </>}
    </> : null}
  </section>
}
