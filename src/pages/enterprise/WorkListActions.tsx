import { Pencil, Pin, PinOff, Trash2 } from 'lucide-react'
import { useEffect, useRef, type KeyboardEvent } from 'react'
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
  onRename: (workId: string, title?: string) => Promise<boolean>
  onPin: (workId: string, pinned: boolean) => Promise<boolean>
  onDelete: (workId: string) => Promise<boolean>
}

/** Workspace actions own their shared confirmation and feedback dialogs. */
export function WorkListActions({ works, request, busy, onDismiss, onRename, onPin, onDelete }: Props) {
  const menuRef = useRef<HTMLDivElement | null>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const menuWork = works.find(work => work.id === request?.workId)
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
    document.addEventListener('pointerdown', dismiss, true)
    document.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', onDismiss)
    return () => {
      document.removeEventListener('pointerdown', dismiss, true)
      document.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', onDismiss)
      if (menu.matches(':popover-open')) menu.hidePopover()
    }
  }, [request, onDismiss])

  useEffect(() => {
    if (request && !menuWork) onDismiss()
  }, [request, menuWork, onDismiss])

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
    <div id="ent-work-context-menu" ref={menuRef} {...{ popover: 'manual' }} role="menu" aria-label="工作记录操作" className="ent-work-context-menu"
      onKeyDown={handleMenuKey}>
      {menuWork && <>
        <button type="button" role="menuitem" disabled={busy} onClick={() => { closeMenu(); void onPin(menuWork.id, !menuWork.pinnedAt) }}>
          {menuWork.pinnedAt ? <PinOff size={16} aria-hidden /> : <Pin size={16} aria-hidden />}{menuWork.pinnedAt ? '取消置顶' : '置顶'}
        </button>
        <button type="button" role="menuitem" disabled={busy} onClick={() => { closeMenu(); void onRename(menuWork.id) }}><Pencil size={16} aria-hidden />重命名</button>
        <button type="button" role="menuitem" className="danger" disabled={busy || cannotDelete(menuWork)} aria-describedby={cannotDelete(menuWork) ? 'ent-work-delete-reason' : undefined} onClick={() => { closeMenu(); void onDelete(menuWork.id) }}><Trash2 size={16} aria-hidden />删除</button>
        {cannotDelete(menuWork) && <p id="ent-work-delete-reason">执行中的工作需先终止，再删除记录。</p>}
      </>}
    </div>
  </>
}
