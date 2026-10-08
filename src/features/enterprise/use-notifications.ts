import { useCallback, useEffect, useReducer, useRef } from 'react'
import { notificationErrorMessage } from './notification-error'
import type { ElectronAPI, IpcCommandResult } from '../../shared/ipc'
import {
  notificationPageSchema, notificationSocketMessageSchema, unreadNotificationCountSchema,
  type NotificationCategory, type PlatformNotification,
} from '../../shared/notification-contracts'
import {
  assertNotificationCommand, initialNotificationState, notificationFingerprint,
  notificationReducer, NOTIFICATION_PAGE_SIZE,
} from './notification-state'

function getAPI(): ElectronAPI {
  const api = typeof window === 'undefined' ? undefined : window.electronAPI
  if (!api || typeof api.listNotifications !== 'function' || typeof api.getUnreadNotificationCount !== 'function' || typeof api.onNotificationUpdate !== 'function') {
    throw new Error('通知服务尚未就绪，请稍后重试。')
  }
  return api
}

export function useNotifications() {
  const [state, dispatch] = useReducer(notificationReducer, initialNotificationState)
  const { category, unreadOnly, offset } = state.query
  const [retryVersion, retry] = useReducer((value: number) => value + 1, 0)
  const sequence = useRef(0)
  const mounted = useRef(false)
  const lifetime = useRef(0)
  const mutationLock = useRef(false)
  const refreshRef = useRef<() => void>(() => undefined)

  useEffect(() => {
    mounted.current = true
    const owner = ++lifetime.current
    return () => { mounted.current = false; lifetime.current = owner + 1 }
  }, [])

  useEffect(() => {
    let active = true
    let inFlight = false
    let queued = false
    let revision = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let unsubscribe: (() => void) | undefined
    let subscriptionError: string | null = null
    const seen = new Map<string, string>()

    function schedule() {
      if (!active) return
      queued = true
      if (inFlight || timer !== undefined) return
      timer = setTimeout(() => { timer = undefined; void refresh() }, 150)
    }

    async function refresh() {
      if (!active || inFlight) { if (active) queued = true; return }
      if (timer !== undefined) { clearTimeout(timer); timer = undefined }
      queued = false
      inFlight = true
      const id = ++sequence.current
      const snapshotRevision = revision
      dispatch({ type: 'start', id })
      try {
        const api = getAPI()
        const categoryQuery = category ? { category } : undefined
        // Each endpoint can fail independently without discarding other cached data.
        const [pageResult, countResult, scopedResult] = await Promise.allSettled([
          api.listNotifications({ category, unreadOnly, offset, limit: NOTIFICATION_PAGE_SIZE }).then(result => {
            assertNotificationCommand(result)
            return notificationPageSchema.parse(result.data)
          }),
          api.getUnreadNotificationCount().then(result => {
            assertNotificationCommand(result)
            return unreadNotificationCountSchema.parse(result.data).count
          }),
          category ? api.getUnreadNotificationCount(categoryQuery).then(result => {
            assertNotificationCommand(result)
            return unreadNotificationCountSchema.parse(result.data).count
          }) : Promise.resolve(undefined),
        ] as const)
        if (!active || snapshotRevision !== revision) return
        const page = pageResult.status === 'fulfilled' ? pageResult.value : undefined
        const unreadCount = countResult.status === 'fulfilled' ? countResult.value : undefined
        const categoryUnreadCount = category ? scopedResult.status === 'fulfilled' ? scopedResult.value : undefined : unreadCount
        const errors = [pageResult, countResult, scopedResult].flatMap(result => result.status === 'rejected' ? [notificationErrorMessage(result.reason)] : [])
        if (subscriptionError) errors.unshift(subscriptionError)
        dispatch({ type: 'finish', id, page, unreadCount, categoryUnreadCount, error: errors.length ? [...new Set(errors)].join('；') : null })
      } catch (error) {
        if (active && snapshotRevision === revision) dispatch({ type: 'finish', id, error: notificationErrorMessage(error) })
      } finally {
        inFlight = false
        if (active && queued) schedule()
      }
    }

    function invalidate() {
      revision++
      dispatch({ type: 'invalidate' })
      schedule()
    }
    refreshRef.current = invalidate
    try {
      // Subscribe first so pushes during the initial REST request cannot be lost.
      unsubscribe = getAPI().onNotificationUpdate(event => {
        if (!active) return
        if (event?.type === 'resync') { invalidate(); return }
        const parsed = notificationSocketMessageSchema.safeParse(event)
        if (!parsed.success || parsed.data.type === 'pong') return
        if (parsed.data.type === 'notification') {
          const item = parsed.data.data
          const fingerprint = notificationFingerprint(item)
          if (seen.get(item.id) === fingerprint) return
          seen.delete(item.id)
          seen.set(item.id, fingerprint)
          if (seen.size > 200) seen.delete(seen.keys().next().value!)
          dispatch({ type: 'push', notification: item })
        }
        if (parsed.data.type === 'connected') {
          dispatch({ type: 'count', count: parsed.data.data.unreadCount })
        } else if (parsed.data.type === 'unread_count') {
          dispatch({ type: 'count', count: parsed.data.data.count })
        }
        // Apply validated socket counts immediately, even if REST is offline.
        // Invalidation prevents pre-event REST snapshots overwriting newer pushes;
        // the following REST compensation remains the canonical reconciliation.
        invalidate()
      })
    } catch (error) {
      subscriptionError = notificationErrorMessage(error)
    }
    void refresh()
    return () => {
      active = false
      if (timer !== undefined) clearTimeout(timer)
      unsubscribe?.()
      refreshRef.current = () => undefined
    }
  }, [category, unreadOnly, offset, retryVersion])

  const runMutation = useCallback(async (command: () => Promise<void>) => {
    if (mutationLock.current || !mounted.current) return
    mutationLock.current = true
    const owner = lifetime.current
    let failure: string | null = null
    dispatch({ type: 'mutation', pending: true, error: null })
    try {
      await command()
      if (mounted.current && lifetime.current === owner) refreshRef.current()
    } catch (error) {
      failure = notificationErrorMessage(error, 'mutation')
    } finally {
      mutationLock.current = false
      if (mounted.current && lifetime.current === owner) dispatch({ type: 'mutation', pending: false, error: failure })
    }
  }, [])

  // Capture failures in state instead of leaving rejected click-handler promises.
  const command = useCallback((operation: (api: ElectronAPI) => Promise<IpcCommandResult>) =>
    runMutation(async () => assertNotificationCommand(await operation(getAPI()))), [runMutation])
  const categoryQuery = category ? { category } : undefined

  return {
    state,
    setCategory: (value?: NotificationCategory) => dispatch({ type: 'query', query: { category: value, unreadOnly: false, offset: 0 } }),
    setUnreadOnly: (value: boolean) => dispatch({ type: 'query', query: { category, unreadOnly: value, offset: 0 } }),
    setOffset: (value: number) => dispatch({ type: 'query', query: { category, unreadOnly, offset: Math.max(0, Math.floor(value / NOTIFICATION_PAGE_SIZE) * NOTIFICATION_PAGE_SIZE) } }),
    retry,
    markRead: (id: string) => command(api => api.markNotificationRead(id)),
    markAllRead: () => command(api => api.markAllNotificationsRead(categoryQuery)),
    deleteNotification: (id: string) => command(api => api.deleteNotification(id)),
    clearRead: () => command(api => api.clearReadNotifications(categoryQuery)),
    openAll: () => command(api => api.openNotificationAction('/notifications')),
    openAction: (notification: PlatformNotification, callback?: (item: PlatformNotification) => void | Promise<void>) => runMutation(async () => {
      if (callback) await callback(notification)
      else if (notification.actionUrl) assertNotificationCommand(await getAPI().openNotificationAction(notification.actionUrl))
    }),
  }
}
