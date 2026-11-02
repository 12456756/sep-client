import { Check, ChevronUp, Search, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPopover } from './use-anchored-popover'
import '../../styles/knowledge-selector.css'

interface Props {
  models: string[]
  value: string
  title: string
  allowEmpty: boolean
  onChange: (modelId: string) => void
}

export function ModelSelector({ models, value, title, allowEmpty, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const { root, popover, position } = useAnchoredPopover(open, setOpen, true)
  const search = useRef<HTMLInputElement>(null)
  const listId = useId()
  const keyword = query.trim().toLowerCase()
  const filtered = models.filter(model => model.toLowerCase().includes(keyword))

  useEffect(() => { if (open) search.current?.focus() }, [open])
  useEffect(() => { if (!models.length) setOpen(false) }, [models.length])

  const choose = (modelId: string) => {
    onChange(modelId)
    setOpen(false)
    root.current?.querySelector('button')?.focus()
  }
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    if ((event.key === 'Home' || event.key === 'End') && event.target === search.current) return
    const options = [...(popover.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])]
    if (!options.length) return
    event.preventDefault()
    const current = options.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : event.key === 'ArrowDown' ? (current + 1) % options.length : current <= 0 ? options.length - 1 : current - 1
    options[next]?.focus()
  }

  return <div className="ent-model-picker ent-rs-model" ref={root} title={title}>
    <button type="button" className="ent-model-trigger" role="combobox" aria-label="模型" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} disabled={!models.length}
      onClick={() => { setQuery(''); setOpen(current => !current) }}
      onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setQuery(''); setOpen(true) } }}>
      <span>{value || '模型'}</span><ChevronUp size={13} aria-hidden className={open ? '' : 'down'} />
    </button>
    {open ? createPortal(<div className="ent-model-popover" ref={popover} role="dialog" aria-label="选择模型" style={position} onKeyDown={navigate}>
      <div className="ent-model-head"><strong>模型</strong><button type="button" className="ent-icon-btn" aria-label="关闭模型选择" onClick={() => { setOpen(false); root.current?.querySelector('button')?.focus() }}><X size={14} /></button></div>
      <label className="ent-model-search"><Search size={14} aria-hidden /><input ref={search} value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索模型" aria-label="搜索模型" /></label>
      <div className="ent-model-options" role="listbox" aria-label="可用模型" id={listId}>
        {allowEmpty && !keyword ? <button type="button" role="option" aria-selected={!value} className="ent-model-option" onClick={() => choose('')}><span>暂不选择</span>{!value ? <Check size={15} aria-hidden /> : null}</button> : null}
        {filtered.map(model => <button type="button" role="option" aria-selected={value === model} className="ent-model-option" key={model} onClick={() => choose(model)}><span>{model}</span>{value === model ? <Check size={15} aria-hidden /> : null}</button>)}
        {!filtered.length ? <span className="ent-knowledge-muted" role="status">没有匹配的模型</span> : null}
      </div>
    </div>, document.body) : null}
  </div>
}
