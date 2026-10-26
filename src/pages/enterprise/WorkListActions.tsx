import { Pencil, Pin, PinOff, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { WorkItem } from '../../features/enterprise/types'

export interface WorkMenuRequest {
  workId: string
  x: number
  y: number
  trigger: HTMLElement
}

interface Props {
  works: WorkItem[]
  request: WorkMenuRequest | null
  busy: boolean
  onDismiss: () => void
  onRename: (workId: string, title: string) => Promise<boolean>
  onPin: (workId: string, pinned: boolean) => Promise<boolean>
  onDelete: (workId: string) => Promise<boolean>
}

/** One top-layer menu and one focused dialog serve every row, without changing selection. */
export function WorkListActions({ works, request, busy, onDismiss, onRename, onPin, onDelete }: Props) {
  const menuRef = useRef<HTMLDivElement | null>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const pending = useRef(false)
  const [action, setAction] = useState<{ kind: 'rename' | 'delete'; workId: string } | null>(null)
  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const menuWork = works.find(work => work.id === request?.workId)
  const actionWork = works.find(work => work.id === action?.workId)
  const actionExists = Boolean(actionWork)
  const cannotDelete = (work: WorkItem) => Boolean(work.isActive || work.status === 'running')

  const restoreFocus = () => {
    if (returnFocus.current?.isConnected) returnFocus.current.focus()
  }
  const closeMenu = (restore = true) => {
    menuRef.current?.hidePopover()
    onDismiss()
    if (restore) restoreFocus()
  }

  useEffect(() => {
    const menu = menuRef.current
    if (!request || !menu) return
    returnFocus.current = request.trigger
    menu.showPopover()
    const rect = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(8, Math.min(request.x, window.innerWidth - rect.width - 8))}px`
    menu.style.top = `${Math.max(8, Math.min(request.y, window.innerHeight - rect.height - 8))}px`
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && menu.contains(event.target)) return
      onDismiss()
    }
    document.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', onDismiss)
    return () => {
      document.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', onDismiss)
      if (menu.matches(':popover-open')) menu.hidePopover()
    }
  }, [request, onDismiss])

  useEffect(() => {
    if (request && !menuWork) onDismiss()
  }, [request, menuWork, onDismiss])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (action && actionExists) {
      if (!dialog.open) dialog.showModal()
      if (action.kind === 'rename') { inputRef.current?.focus(); inputRef.current?.select() }
      else cancelRef.current?.focus()
    } else {
      if (dialog.open) {
        dialog.close()
        if (!returnFocus.current?.isConnected) dialog.closest('.ent-work-hub')?.querySelector<HTMLInputElement>('.ent-work-search input')?.focus()
      }
      if (action) setAction(null)
    }
  }, [action, actionExists])

  useEffect(() => {
    const dialog = dialogRef.current
    return () => { if (dialog?.open) dialog.close() }
  }, [])

  const openAction = (kind: 'rename' | 'delete') => {
    if (!menuWork) return
    setTitle(menuWork.title)
    setError(null)
    setAction({ kind, workId: menuWork.id })
    closeMenu()
  }
  const closeAction = () => {
    if (pending.current) return
    setAction(null)
    restoreFocus()
  }
  const submit = async () => {
    if (!action || !actionWork || busy || pending.current) return
    const nextTitle = title.trim()
    if (action.kind === 'rename' && (!nextTitle || nextTitle.length > 100 || Array.from(nextTitle).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) {
      setError('请输入 1–100 个字符的名称，不包含换行或控制字符。')
      return
    }
    if (action.kind === 'delete' && cannotDelete(actionWork)) {
      setError('工作正在执行，请先终止工作，再删除记录。')
      return
    }
    pending.current = true
    setSaving(true)
    setError(null)
    try {
      const ok = action.kind === 'rename'
        ? await onRename(action.workId, nextTitle)
        : await onDelete(action.workId)
      if (ok) { setAction(null); restoreFocus() }
      else setError(action.kind === 'rename' ? '名称没能保存，请重试。' : '记录没能删除，请重试。')
    } catch {
      setError('操作没能完成，请重试。')
    } finally {
      pending.current = false
      setSaving(false)
    }
  }
  const handleMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items[next]?.focus()
    } else if (event.key === 'Escape') { event.preventDefault(); closeMenu() }
    else if (event.key === 'Tab') closeMenu(false)
  }

  return <>
    <div id="ent-work-context-menu" ref={menuRef} role="menu" aria-label="工作记录操作" className="ent-work-context-menu"
      onKeyDown={handleMenuKey}>
      {menuWork && <>
        <button type="button" role="menuitem" disabled={busy} onClick={() => { closeMenu(); void onPin(menuWork.id, !menuWork.pinnedAt) }}>
          {menuWork.pinnedAt ? <PinOff size={16} aria-hidden /> : <Pin size={16} aria-hidden />}{menuWork.pinnedAt ? '取消置顶' : '置顶'}
        </button>
        <button type="button" role="menuitem" disabled={busy} onClick={() => openAction('rename')}><Pencil size={16} aria-hidden />重命名</button>
        <button type="button" role="menuitem" className="danger" disabled={busy || cannotDelete(menuWork)} aria-describedby={cannotDelete(menuWork) ? 'ent-work-delete-reason' : undefined} onClick={() => openAction('delete')}><Trash2 size={16} aria-hidden />删除</button>
        {cannotDelete(menuWork) && <p id="ent-work-delete-reason">执行中的工作需先终止，再删除记录。</p>}
      </>}
    </div>
    <dialog ref={dialogRef} className="ent-work-action-dialog" aria-labelledby="ent-work-action-title" aria-describedby="ent-work-action-description" aria-modal="true"
      onCancel={event => { event.preventDefault(); closeAction() }} onClose={() => { if (!pending.current) setAction(null) }}
      onClick={event => {
        if (event.target !== event.currentTarget) return
        const rect = event.currentTarget.getBoundingClientRect()
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeAction()
      }}>
      {action && actionWork && <form onSubmit={event => { event.preventDefault(); void submit() }}>
        <header><h2 id="ent-work-action-title">{action.kind === 'rename' ? '重命名工作' : '删除工作记录'}</h2><button type="button" aria-label="关闭操作窗口" disabled={saving} onClick={closeAction}><X size={18} aria-hidden /></button></header>
        {action.kind === 'rename' ? <>
          <p id="ent-work-action-description">为这项工作设置一个便于查找的名称。</p>
          <label htmlFor="ent-work-new-title">工作名称</label>
          <input ref={inputRef} id="ent-work-new-title" value={title} maxLength={100} disabled={saving} autoComplete="off" aria-invalid={Boolean(error)} aria-describedby={error ? 'ent-work-action-error' : undefined} onChange={event => { setTitle(event.target.value); setError(null) }} />
        </> : <p id="ent-work-action-description">删除“{actionWork.title || '未命名工作'}”后，对话、过程和结果说明会从列表消失，且无法恢复。已产出的文件仍保留在工作文件夹中。</p>}
        {action.kind === 'delete' && cannotDelete(actionWork) && <p role="status">工作已开始执行，请先取消本次操作并终止工作，再删除记录。</p>}
        {error && <p className="ent-work-action-error" id="ent-work-action-error" role="alert">{error}</p>}
        <footer><button ref={cancelRef} type="button" className="ent-btn ghost" disabled={saving} onClick={closeAction}>取消</button><button type="submit" className={`ent-btn ${action.kind === 'delete' ? 'danger' : 'primary'}`} disabled={busy || saving || (action.kind === 'rename' ? !title.trim() : cannotDelete(actionWork))}>{saving ? action.kind === 'delete' ? '正在删除…' : '正在保存…' : action.kind === 'rename' ? '保存名称' : '确认删除'}</button></footer>
      </form>}
    </dialog>
  </>
}
