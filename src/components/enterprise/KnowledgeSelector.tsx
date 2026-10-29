import { BookOpen, Check, ChevronUp, LoaderCircle, Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { KnowledgeSelection } from '../../shared/knowledge-selection'
import { noKnowledgeSelection } from '../../shared/knowledge-selection'
import type { KnowledgeData } from '../../shared/knowledge-contracts'
import { useKnowledgeClient } from '../../features/knowledge/use-knowledge'
import { useAnchoredPopover } from './use-anchored-popover'
import '../../styles/knowledge-selector.css'

type KnowledgeBase = KnowledgeData<'list'>['items'][number]
interface Props {
  value?: KnowledgeSelection
  onChange: (value: KnowledgeSelection) => void
  disabled?: boolean
  className?: string
  scopeKey?: string
}

export function KnowledgeSelector({ value = noKnowledgeSelection(), onChange, disabled = false, className = '', scopeKey = '' }: Props) {
  const { client } = useKnowledgeClient()
  const [open, setOpen] = useState(false)
  const [bases, setBases] = useState<KnowledgeBase[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [basePage, setBasePage] = useState(1)
  const [baseTotal, setBaseTotal] = useState(0)
  const [baseRevision, setBaseRevision] = useState(0)
  const [baseError, setBaseError] = useState('')
  const { root, popover, position } = useAnchoredPopover(open, setOpen)
  const previousScope = useRef(scopeKey)

  useEffect(() => {
    if (!open) return
    let active = true
    setBaseError('')
    setLoading(true)
    void client.run({ action: 'list', page: basePage, pageSize: 50, ...(query.trim() ? { keyword: query.trim() } : {}) }, 'knowledge-list').then(data => {
      if (!active) return
      setBases(current => basePage === 1 ? data.items : [...current, ...data.items.filter(item => !current.some(existing => existing.id === item.id))])
      setBaseTotal(data.total)
    }).catch(() => { if (active) setBaseError('知识库列表加载失败，请重试。') }).finally(() => { if (active) setLoading(false) })
    return () => { active = false; client.cancelGroup('knowledge-list') }
  }, [basePage, baseRevision, client, open, query, scopeKey])

  useEffect(() => {
    if (value.mode !== 'manual') return
    // Older drafts may still carry the retired manual retrieval mode.
    onChange(value.knowledgeBaseIds.length ? { mode: 'auto', knowledgeBaseIds: value.knowledgeBaseIds } : noKnowledgeSelection())
  }, [onChange, value])

  useEffect(() => {
    if (previousScope.current === scopeKey) return
    previousScope.current = scopeKey
    client.cancelAll()
    setOpen(false); setQuery(''); setBases([]); setBasePage(1); setBaseTotal(0)
    onChange(noKnowledgeSelection())
    // The owner changes only when the authenticated scope changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, client])

  const ids = new Set(value.knowledgeBaseIds)
  const summary = ids.size ? `知识库 · ${ids.size}` : '知识库'
  const setBaseFilter = (next: string) => { setBases([]); setBasePage(1); setBaseTotal(0); setQuery(next) }
  const toggleBase = (id: string) => {
    const next = new Set(ids)
    if (next.has(id)) next.delete(id); else if (next.size < 100) next.add(id)
    onChange(next.size ? { mode: 'auto', knowledgeBaseIds: [...next] } : noKnowledgeSelection())
  }
  return <div className={`ent-knowledge-picker ${className}`} ref={root}>
    <button type="button" className="ent-tool-button" aria-expanded={open} disabled={disabled} onClick={() => { setBasePage(1); setBases([]); setOpen(current => !current) }} title="选择知识库"><BookOpen size={15} aria-hidden />{summary}<ChevronUp size={13} aria-hidden className={open ? '' : 'down'} /></button>
    {open ? createPortal(<div ref={popover} className="ent-knowledge-popover" role="dialog" aria-label="选择知识库" style={position}>
      <div className="ent-knowledge-head"><strong>知识库</strong><button type="button" className="ent-icon-btn" onClick={() => setOpen(false)} aria-label="关闭"><X size={14} /></button></div>
      <label className="ent-knowledge-search"><Search size={14} /><input value={query} onChange={event => setBaseFilter(event.target.value)} placeholder="搜索知识库" aria-label="搜索知识库" /></label>
      <div className="ent-knowledge-bases">{loading && !bases.length ? <span className="ent-knowledge-muted"><LoaderCircle size={14} className="spin" />加载中</span> : bases.map(base => <button type="button" className="ent-knowledge-base" aria-pressed={ids.has(base.id)} key={base.id} onClick={() => toggleBase(base.id)}><span>{base.name}</span>{ids.has(base.id) ? <Check size={15} /> : null}</button>)}{baseError ? <span role="alert" className="ent-knowledge-error">{baseError}<button type="button" onClick={() => setBaseRevision(current => current + 1)}>重试</button></span> : null}{!loading && !baseError && !bases.length ? <span className="ent-knowledge-muted">暂无可访问知识库</span> : null}</div>
      {bases.length < baseTotal && !baseError ? <button type="button" className="ent-knowledge-more" disabled={loading} onClick={() => setBasePage(page => page + 1)}>{loading ? '加载中…' : '加载更多'}</button> : null}
      <p className="ent-knowledge-hint">{ids.size ? '已选择的知识库将在提问时按需使用。' : '默认不使用知识库，选择后使用。'}</p>
    </div>, document.body) : null}
  </div>
}
