import type { IpcCommandResult } from '../../shared/ipc'
import type { NotificationCategory, NotificationPage, PlatformNotification } from '../../shared/notification-contracts'

export const NOTIFICATION_PAGE_SIZE = 50
const SEEN_LIMIT = 200

export interface NotificationFilters {
  category?: NotificationCategory
  unreadOnly: boolean
  offset: number
}

export interface NotificationState {
  query: NotificationFilters
  items: PlatformNotification[]
  total: number
  unreadCount: number | null
  categoryUnreadCount: number | null
  loading: boolean
  error: string | null
  mutationError: string | null
  pending: boolean
  requestId: number | null
  seen: Record<string, string>
}

export const initialNotificationState: NotificationState = {
  query: { unreadOnly: false, offset: 0 }, items: [], total: 0,
  unreadCount: null, categoryUnreadCount: null, loading: true, error: null,
  mutationError: null, pending: false, requestId: null, seen: {},
}

export type NotificationStateAction =
  | { type: 'query'; query: NotificationFilters }
  | { type: 'start'; id: number }
  | { type: 'finish'; id: number; page?: NotificationPage; unreadCount?: number; categoryUnreadCount?: number; error: string | null }
  | { type: 'push'; notification: PlatformNotification }
  | { type: 'invalidate' }
  | { type: 'count'; count: number }
  | { type: 'mutation'; pending: boolean; error: string | null }

export function notificationFingerprint(notification: PlatformNotification): string {
  return JSON.stringify(notification)
}

function remember(seen: Record<string, string>, items: PlatformNotification[]): Record<string, string> {
  // Rebuild instead of mutating state; keep a bounded insertion-order cache.
  const entries = new Map(Object.entries(seen))
  for (const item of items) {
    entries.delete(item.id)
    entries.set(item.id, notificationFingerprint(item))
  }
  return Object.fromEntries([...entries].slice(-SEEN_LIMIT))
}

function matches(item: PlatformNotification, query: NotificationFilters): boolean {
  return (!query.category || item.category === query.category) && (!query.unreadOnly || !item.read)
}

export function assertNotificationCommand(result: IpcCommandResult): void {
  // A successful 204 has no data. Only the IPC success envelope matters.
  if (!result.success) throw new Error(result.error?.message || '通知操作失败，请重试。')
}

export function notificationReducer(state: NotificationState, action: NotificationStateAction): NotificationState {
  switch (action.type) {
    case 'query':
      if (state.query.category === action.query.category && state.query.unreadOnly === action.query.unreadOnly && state.query.offset === action.query.offset) return state
      return { ...state, query: action.query, items: [], total: 0, loading: true, error: null,
        requestId: null, seen: {}, categoryUnreadCount: state.query.category === action.query.category ? state.categoryUnreadCount : null }
    case 'start':
      return { ...state, requestId: action.id, loading: true }
    case 'finish': {
      if (state.requestId !== action.id) return state
      const page = action.page
      const items = page ? [...new Map(page.items.filter(item => matches(item, state.query)).map(item => [item.id, item])).values()].slice(0, NOTIFICATION_PAGE_SIZE) : state.items
      const offset = page && state.query.offset > 0 && state.query.offset >= page.total
        ? Math.max(0, Math.floor((page.total - 1) / NOTIFICATION_PAGE_SIZE) * NOTIFICATION_PAGE_SIZE) : state.query.offset
      return { ...state, items: offset === state.query.offset ? items : [], total: page?.total ?? state.total,
        query: offset === state.query.offset ? state.query : { ...state.query, offset },
        unreadCount: action.unreadCount ?? state.unreadCount,
        categoryUnreadCount: action.categoryUnreadCount ?? state.categoryUnreadCount,
        loading: offset !== state.query.offset, error: action.error, requestId: null,
        seen: page ? remember(state.seen, items) : state.seen }
    }
    case 'push': {
      const item = action.notification
      const existing = state.items.find(row => row.id === item.id)
      if ((existing ? notificationFingerprint(existing) : state.seen[item.id]) === notificationFingerprint(item)) return state
      let items = state.items.filter(row => row.id !== item.id)
      if (matches(item, state.query)) {
        if (existing) items = state.items.map(row => row.id === item.id ? item : row)
        else if (state.query.offset === 0) items = [item, ...items].slice(0, NOTIFICATION_PAGE_SIZE)
      }
      return { ...state, items, seen: remember(state.seen, [item]), requestId: null }
    }
    case 'count':
      return { ...state, unreadCount: action.count,
        categoryUnreadCount: state.query.category ? state.categoryUnreadCount : action.count, requestId: null }
    case 'invalidate':
      return { ...state, requestId: null }
    case 'mutation':
      return { ...state, pending: action.pending, mutationError: action.error }
  }
}
