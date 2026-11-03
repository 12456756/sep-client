import { Check, ChevronUp, Search, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPopover } from './use-anchored-popover'
import { useModelCatalog } from './ModelCatalogContext'
import { modelBillingLabel } from '../../shared/model-catalog-contracts'
import '../../styles/knowledge-selector.css'

interface Props {
  models: string[]
  value: string
  title: string
  allowEmpty: boolean
  disabled?: boolean
  onChange: (modelId: string) => void
}

export function ModelSelector({ models, value, title, allowEmpty, disabled = false, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const { root, popover, position } = useAnchoredPopover(open, setOpen, true)
  const search = useRef<HTMLInputElement>(null)
  const listId = useId()
  const catalog = useModelCatalog()
  const catalogById = new Map(catalog.models.map(model => [model.modelId, model]))
  const keyword = query.trim().toLowerCase()
  const filtered = models.map(modelId => catalogById.get(modelId) ?? {
    modelId, displayName: modelId, billingMultiplier: null, discountLabel: null, isFree: null,
  }).filter(model => `${model.modelId} ${model.displayName}`.toLowerCase().includes(keyword))
  const selected = models.includes(value) ? catalogById.get(value) : undefined
  const selectedBilling = selected ? modelBillingLabel(selected) : null
  const triggerTitle = selected
    ? [selected.displayName, selectedBilling].filter(Boolean).join(' · ')
    : title

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

  return <div className="ent-model-picker ent-rs-model" ref={root} title={triggerTitle}>
    <button type="button" className="ent-model-trigger" role="combobox" aria-label="模型" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} disabled={disabled || !models.length}
      onClick={() => { setQuery(''); setOpen(current => !current) }}
      onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setQuery(''); setOpen(true) } }}>
      <span>{value ? selected?.displayName ?? value : '模型'}</span>
      {selectedBilling ? <small className={selected?.isFree === true ? 'ent-model-current-billing is-free' : 'ent-model-current-billing'} title={selectedBilling}>{selectedBilling}</small> : null}
      <ChevronUp size={13} aria-hidden className={open ? '' : 'down'} />
    </button>
    {open ? createPortal(<div className="ent-model-popover" ref={popover} role="dialog" aria-label="选择模型" style={position} onKeyDown={navigate}>
      <div className="ent-model-head"><strong>模型</strong><button type="button" className="ent-icon-btn" aria-label="关闭模型选择" onClick={() => { setOpen(false); root.current?.querySelector('button')?.focus() }}><X size={14} /></button></div>
      <label className="ent-model-search"><Search size={14} aria-hidden /><input ref={search} value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索模型" aria-label="搜索模型" /></label>
      <div className="ent-model-options" role="listbox" aria-label="可用模型" id={listId}>
        {allowEmpty && !keyword ? <button type="button" role="option" aria-selected={!value} className="ent-model-option" onClick={() => choose('')}><span>暂不选择</span>{!value ? <Check size={15} aria-hidden /> : null}</button> : null}
        {filtered.map(model => {
          const billingLabel = modelBillingLabel(model)
          return <button type="button" role="option" aria-label={model.displayName} aria-selected={value === model.modelId} className="ent-model-option" key={model.modelId} onClick={() => choose(model.modelId)}>
            <span className="ent-model-option-copy"><span>{model.displayName}</span>{billingLabel ? <small className={model.isFree === true ? 'is-free' : undefined}>{billingLabel}</small> : null}</span>
            {value === model.modelId ? <Check size={15} aria-hidden /> : null}
          </button>
        })}
        {!filtered.length ? <span className="ent-knowledge-muted" role="status">没有匹配的模型</span> : null}
      </div>
      {catalog.error ? <div className="ent-model-catalog-error" role="status"><span>模型计费信息加载失败</span>{catalog.retry ? <button type="button" onClick={catalog.retry}>重试</button> : null}</div> : null}
    </div>, document.body) : null}
  </div>
}
