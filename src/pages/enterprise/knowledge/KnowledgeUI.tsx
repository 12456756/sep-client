import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { KnowledgeClientError } from '../../../features/knowledge/knowledge-client'

export function KnowledgeDialog({ title, description, children, onClose, busy = false }: { title: string; description: string; children: ReactNode; onClose(): void; busy?: boolean }) {
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose() }}><Dialog.Portal>
    <Dialog.Overlay className="kb-overlay" />
    <Dialog.Content className="kb-dialog"><Dialog.Title>{title}</Dialog.Title><Dialog.Description>{description}</Dialog.Description>
      {children}<Dialog.Close className="kb-close ent-icon-btn" aria-label="关闭弹窗" disabled={busy}><X size={18} /></Dialog.Close>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>
}
export function KnowledgeErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null
  const detail = error instanceof KnowledgeClientError ? error.detail : null
  return <div className="kb-error" role="alert"><div><strong>{detail?.message ?? '操作未能完成，请稍后重试。'}</strong>
    {detail?.requestId ? <small>请求编号：{detail.requestId}</small> : null}
    {detail?.retryAfterMs ? <small>服务端要求等待 {Math.ceil(detail.retryAfterMs / 1000)} 秒，请稍后再试。</small> : null}
  </div>{onRetry ? <button className="ent-btn sm" onClick={onRetry}>刷新</button> : null}</div>
}
export function KnowledgePager({ page, pageSize = 20, total, disabled = false, onChange }: { page: number; pageSize?: number; total: number; disabled?: boolean; onChange(page: number): void }) {
  return <div className="kb-pager"><span>共 {total} 项 · 第 {page} 页</span><button className="ent-btn sm" disabled={disabled || page <= 1} onClick={() => onChange(page - 1)}>上一页</button><button className="ent-btn sm" disabled={disabled || page * pageSize >= total} onClick={() => onChange(page + 1)}>下一页</button></div>
}
export function KnowledgeSearchForm({ placeholder, onSearch, disabled = false }: { placeholder: string; onSearch(value: string): void; disabled?: boolean }) {
  const [value, setValue] = useState('')
  return <form className="kb-search-form" onSubmit={(event: FormEvent) => { event.preventDefault(); onSearch(value.trim()) }}>
    <input className="ent-input" aria-label={placeholder} placeholder={placeholder} value={value} maxLength={200} onChange={event => setValue(event.target.value)} />
    <button className="ent-btn" disabled={disabled}>搜索</button>
  </form>
}
