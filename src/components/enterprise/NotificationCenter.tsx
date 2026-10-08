import { BarChart2, Bell, Check, CheckSquare, CircleAlert, ExternalLink, Settings2, ShieldAlert, Trash2, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { NotificationCategory, PlatformNotification } from '../../shared/notification-contracts'
import { NOTIFICATION_PAGE_SIZE, type NotificationState } from '../../features/enterprise/notification-state'
import { useNotifications } from '../../features/enterprise/use-notifications'
import { notificationTimeLabel } from '../../features/enterprise/notification-time'

// The integrator imports src/styles/notifications.css alongside enterprise.css.
// Keeping CSS out of this module also supports the repository's node:test SSR tests.
const categories: Record<NotificationCategory, string> = {
  SYSTEM: '系统', USAGE_ALERT: '用量', SECURITY: '安全', APPROVAL: '审批',
}

const categoryIcons = { SYSTEM: Settings2, USAGE_ALERT: BarChart2, SECURITY: ShieldAlert, APPROVAL: CheckSquare }
const categoryTabs = [undefined, 'SYSTEM', 'USAGE_ALERT', 'SECURITY', 'APPROVAL'] as const

interface PanelProps {
  id: string
  state: NotificationState
  onClose: () => void
  onCategory: (category?: NotificationCategory) => void
  onPage: (offset: number) => void
  onRetry: () => void
  onRead: (id: string) => void
  onReadAll: () => void
  onDelete: (id: string) => void
  onViewAll: () => void
  onAction: (notification: PlatformNotification) => void
  hasInternalActions?: boolean
}

/** Presentational panel kept separate so markup can be regression-tested with SSR. */
export function NotificationPanel(props: PanelProps) {
  const { id, state, onClose, onCategory, onPage, onRetry, onRead, onReadAll, onDelete, onViewAll, onAction } = props
  const { category, unreadOnly, offset } = state.query
  const page = Math.floor(offset / NOTIFICATION_PAGE_SIZE) + 1
  const pages = Math.ceil(state.total / NOTIFICATION_PAGE_SIZE)
  const hasItems = state.items.length > 0
  return (
    <section id={id} className="ent-notification-panel" role="dialog" aria-labelledby={`${id}-title`}>
      <header className="ent-notification-header">
        <h2 id={`${id}-title`}>通知</h2>
        <div className="ent-notification-header-actions">
          <button type="button" className="ent-notification-read-all" aria-label="全部标为已读"
            title={category ? `将${categories[category]}通知全部标为已读` : '将全部通知标为已读'}
            disabled={state.pending || state.categoryUnreadCount === 0} onClick={onReadAll}>
            <Check size={17} aria-hidden="true" /><span>全部已读</span>
          </button>
          <button type="button" className="ent-notification-icon-action" aria-label="关闭通知中心" title="关闭" onClick={onClose} data-notification-entry>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="ent-notification-tabs" role="group" aria-label="通知分类">
        {categoryTabs.map(value => {
          const Icon = value ? categoryIcons[value] : Bell
          const label = value ? categories[value] : '全部'
          return <button type="button" key={value ?? 'ALL'} aria-label={label} aria-pressed={category === value}
            onClick={() => onCategory(value)}><Icon size={15} aria-hidden="true" /><span>{label}</span></button>
        })}
      </div>
      {state.mutationError && <div className="ent-notification-note" role="alert">{state.mutationError}</div>}
      {state.pending && <p className="ent-notification-status ent-notification-progress" role="status">正在处理…</p>}
      <div className="ent-notification-content" aria-busy={state.loading}>
        {state.error && (hasItems ? (
          <div className="ent-notification-note" role="alert">
            <CircleAlert size={14} aria-hidden="true" /><span>{state.error}</span>
            <button type="button" aria-label="重试加载通知" disabled={state.loading} onClick={onRetry}>重试</button>
          </div>
        ) : (
          <div className="ent-notification-empty" role="alert">
            <CircleAlert size={24} aria-hidden="true" />
            <h3>暂时无法加载通知</h3>
            <p>{state.error}</p>
            <button type="button" aria-label="重试加载通知" disabled={state.loading} onClick={onRetry}>重试</button>
          </div>
        ))}
        {state.loading && (!state.error || hasItems) && (
          <p className={`ent-notification-status${hasItems ? ' ent-notification-progress' : ' ent-notification-empty'}`} role="status">
            {hasItems ? '正在更新通知…' : '正在加载通知…'}
          </p>
        )}
        {!state.loading && !state.error && !hasItems && (
          <div className="ent-notification-empty" role="status">
            <Bell size={24} aria-hidden="true" />
            <p>{unreadOnly ? '暂无未读通知' : '暂无通知'}</p>
          </div>
        )}
        {hasItems && <ul className="ent-notification-list">
          {state.items.map(notification => {
            const internalAction = props.hasInternalActions && (notification.category === 'USAGE_ALERT'
              || notification.type === 'SKILL_VERSION_UPDATED' || notification.type === 'CONTRIBUTION_REWARD_CREDITED')
            const actionLabel = internalAction ? '查看详情' : notification.actionUrl ? '在平台查看' : null
            return (
              <li key={notification.id} className={`ent-notification-item${notification.read ? '' : ' is-unread'}`}>
                {!notification.read && <span className="ent-notification-unread-dot" role="img" aria-label="未读" />}
                <article>
                  <div className="ent-notification-row-heading">
                    <div className="ent-notification-row-title">
                      <h3>{notification.title}</h3>
                      <span className={`ent-notification-category-tag is-${notification.category.toLowerCase()}`}>{categories[notification.category]}</span>
                    </div>
                    <time dateTime={notification.createdAt} title={new Date(notification.createdAt).toLocaleString('zh-CN')}>
                      {notificationTimeLabel(notification.createdAt)}
                    </time>
                  </div>
                  <p className="ent-notification-message">{notification.message}</p>
                  <div className="ent-notification-row-footer">
                    <div className="ent-notification-row-actions">
                      {actionLabel && <button type="button" className="ent-notification-view-action" disabled={state.pending}
                        onClick={() => onAction(notification)} aria-label={`${actionLabel}：${notification.title}`}>{actionLabel}</button>}
                      {!notification.read && <button type="button" className="ent-notification-icon-action" disabled={state.pending}
                        onClick={() => onRead(notification.id)} aria-label={`标为已读：${notification.title}`} title="标为已读">
                        <Check size={15} aria-hidden="true" />
                      </button>}
                      <button type="button" className="ent-notification-icon-action ent-notification-delete" disabled={state.pending}
                        onClick={() => onDelete(notification.id)} aria-label={`删除通知：${notification.title}`} title="删除通知">
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                </article>
              </li>
            )
          })}
        </ul>}
      </div>
      {pages > 1 && <div className="ent-notification-pagination">
        <button type="button" aria-label="上一页" disabled={state.loading || offset === 0} onClick={() => onPage(offset - NOTIFICATION_PAGE_SIZE)}>上一页</button>
        <span aria-live="polite">第 {page} / {pages} 页</span>
        <button type="button" aria-label="下一页" disabled={state.loading || offset + NOTIFICATION_PAGE_SIZE >= state.total} onClick={() => onPage(offset + NOTIFICATION_PAGE_SIZE)}>下一页</button>
      </div>}
      <footer className="ent-notification-footer">
        <button type="button" aria-label="查看全部通知" disabled={state.pending} onClick={onViewAll}>
          <ExternalLink size={14} aria-hidden="true" />查看全部通知
        </button>
      </footer>
    </section>
  )
}

export function NotificationCenter({ onOpenAction }: {
  onOpenAction?: (notification: PlatformNotification) => void | Promise<void>
}) {
  const notifications = useNotifications()
  const [open, setOpen] = useState(false)
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const bell = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)

  useEffect(() => {
    if (!open) {
      if (wasOpen.current) bell.current?.focus({ preventScroll: true })
      wasOpen.current = false
      return
    }
    wasOpen.current = true
    const panel = root.current?.querySelector<HTMLElement>('[role="dialog"]')
    panel?.querySelector<HTMLButtonElement>('[data-notification-entry]')?.focus({ preventScroll: true })
    // A fixed popover avoids clipping by top-bar containers. It remains inside
    // the enterprise shell in the DOM so dark-theme tokens keep inheriting.
    function positionPanel() {
      const anchor = bell.current?.getBoundingClientRect()
      if (!anchor || !panel) return
      const gap = 8
      const width = Math.min(380, Math.max(0, window.innerWidth - gap * 2))
      const top = Math.min(anchor.bottom + gap, Math.max(gap, window.innerHeight - 160))
      panel.style.width = `${width}px`
      panel.style.left = `${Math.max(gap, Math.min(anchor.right - width, window.innerWidth - width - gap))}px`
      panel.style.top = `${top}px`
      panel.style.maxHeight = `${Math.min(560, Math.max(0, window.innerHeight - top - gap))}px`
    }
    positionPanel()
    function pointerDown(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    function keyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
    }
    document.addEventListener('pointerdown', pointerDown)
    document.addEventListener('keydown', keyDown)
    window.addEventListener('resize', positionPanel)
    window.addEventListener('scroll', positionPanel, true)
    return () => {
      document.removeEventListener('pointerdown', pointerDown)
      document.removeEventListener('keydown', keyDown)
      window.removeEventListener('resize', positionPanel)
      window.removeEventListener('scroll', positionPanel, true)
    }
  }, [open])

  const count = notifications.state.unreadCount
  return (
    <div className="ent-notification-center" ref={root}>
      <button type="button" className="ent-top-icon ent-notification-bell" ref={bell}
        aria-label={count === null ? '通知中心，未读数尚未加载' : `通知中心，${count} 条未读`}
        aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={() => setOpen(value => !value)}>
        <Bell size={18} aria-hidden="true" />
        {count !== null && count > 0 && <span className="ent-notification-badge" aria-hidden="true">{count}</span>}
      </button>
      {open && <NotificationPanel id={id} state={notifications.state} onClose={() => setOpen(false)}
        onCategory={notifications.setCategory}
        onPage={notifications.setOffset} onRetry={notifications.retry} onRead={notifications.markRead}
        onReadAll={notifications.markAllRead} onDelete={notifications.deleteNotification}
        onViewAll={notifications.openAll} hasInternalActions={Boolean(onOpenAction)} onAction={notification => { void notifications.openAction(notification, onOpenAction) }} />}
    </div>
  )
}
