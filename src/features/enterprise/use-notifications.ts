import { useCallback, useEffect, useReducer, useRef } from 'react'
import { notificationCooldownDelay, notificationErrorMessage, notificationRetryDelay } from './notification-error'
import type { ElectronAPI, IpcCommandResult } from '../../shared/ipc'
import {
  notificationPageSchema, notificationSocketMessageSchema, unreadNotificationCountSchema,
  type NotificationCategory, type PlatformNotification,
} from '../../shared/notification-contracts'
import {
  assertNotificationCommand, initialNotificationState, notificationFingerprint,
  notificationReducer, NOTIFICATION_PAGE_SIZE, type NotificationFilters,
} from './notification-state'

const COUNT_FRESH_MS = 30_000
const EVENT_REFRESH_MS = 2000
interface CachedCount { count: number; at: number }

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
  const sequence = useRef(0)
  const mounted = useRef(false)
  const lifetime = useRef(0)
  const mutationLock = useRef(false)
  const cooldownUntil = useRef(0)
  const refreshRef = useRef<(forceCounts?: boolean) => void>(() => undefined)
  const queryRef = useRef<(query: NotificationFilters) => void>(() => undefined)
  const failureRef = useRef<(error: unknown) => void>(() => undefined)

  // One scheduler/subscription per login lifetime. Filters and manual refreshes
  // update its inputs instead of replacing in-flight work and cooldown timers.
  useEffect(() => {
    mounted.current = true
    const owner = ++lifetime.current
    let active = true
    let query = initialNotificationState.query
    let inFlight = false
    let queued = false
    let queuedAt = 0
    let revision = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let timerAt = 0
    let retryAttempt = 0
    let retryAt = 0
    let lastRefreshAt = 0
    let unsubscribe: (() => void) | undefined
    let subscriptionError: string | null = null
    const seen = new Map<string, string>()
    const counts = new Map<string, CachedCount>()

    function arm() {
      if (!active || !queued || inFlight) return
      const at = Math.max(Date.now(), queuedAt, cooldownUntil.current, retryAt)
      if (timer !== undefined && timerAt <= at) return
      if (timer !== undefined) clearTimeout(timer)
      timerAt = at
      // Browsers clamp larger timeouts to 1ms; keep long Retry-After values safe.
      timer = setTimeout(() => { timer = undefined; void refresh() }, Math.min(2_147_483_647, Math.max(0, at - Date.now())))
    }

    function schedule(delay = 150) {
      const at = Date.now() + delay
      queuedAt = queued ? Math.min(queuedAt, at) : at
      queued = true
      if (cooldownUntil.current > Date.now()) {
        dispatch({ type: 'wait', error: notificationErrorMessage({ code: 'RATE_LIMITED' }) })
      }
      arm()
    }

    function recordFailures(errors: unknown[]) {
      if (!active) return
      const now = Date.now()
      for (const error of errors) {
        const delay = notificationCooldownDelay(error)
        if (delay !== null) cooldownUntil.current = Math.max(cooldownUntil.current, now + delay)
      }
      if (cooldownUntil.current > now) {
        dispatch({ type: 'cooldown', until: cooldownUntil.current })
      }
      const delays = errors.flatMap(error => {
        const delay = notificationRetryDelay(error, retryAttempt)
        return delay === null ? [] : [delay]
      })
      if (!errors.length) retryAttempt = 0
      if (delays.length) {
        retryAttempt++
        retryAt = now + Math.max(...delays)
        if (!queued) queuedAt = now
        queued = true
      }
    }

    async function readCount(api: ElectronAPI, value?: NotificationCategory): Promise<CachedCount> {
      const cached = counts.get(value ?? 'ALL')
      if (cached && Date.now() - cached.at < COUNT_FRESH_MS) return cached
      const result = await api.getUnreadNotificationCount(value ? { category: value } : undefined)
      assertNotificationCommand(result)
      return { count: unreadNotificationCountSchema.parse(result.data).count, at: Date.now() }
    }

    async function refresh() {
      if (!active || inFlight) return
      const now = Date.now()
      if (Math.max(cooldownUntil.current, retryAt) > now) { arm(); return }
      if (cooldownUntil.current !== 0) {
        cooldownUntil.current = 0
        dispatch({ type: 'cooldown', until: 0 })
      }
      retryAt = 0
      queued = false
      inFlight = true
      lastRefreshAt = now
      const id = ++sequence.current
      const snapshotRevision = revision
      const snapshot = query
      dispatch({ type: 'start', id })
      try {
        const api = getAPI()
        const [pageResult, countResult, scopedResult] = await Promise.allSettled([
          api.listNotifications({ ...snapshot, limit: NOTIFICATION_PAGE_SIZE }).then(result => {
            assertNotificationCommand(result)
            return notificationPageSchema.parse(result.data)
          }),
          readCount(api),
          snapshot.category ? readCount(api, snapshot.category) : Promise.resolve(undefined),
        ] as const)
        if (!active) return
        const failures = [pageResult, countResult, scopedResult].flatMap(result => result.status === 'rejected' ? [result.reason] : [])
        // Even an obsolete filter's 429 must protect subsequent requests.
        recordFailures(failures)
        if (snapshotRevision !== revision) {
          if (cooldownUntil.current > Date.now()) dispatch({ type: 'wait', error: notificationErrorMessage({ code: 'RATE_LIMITED' }) })
          return
        }
        const page = pageResult.status === 'fulfilled' ? pageResult.value : undefined
        const globalCount = countResult.status === 'fulfilled' ? countResult.value : undefined
        const scopedCount = scopedResult.status === 'fulfilled' ? scopedResult.value : undefined
        const unreadCount = globalCount?.count
        const categoryUnreadCount = snapshot.category ? scopedCount?.count : unreadCount
        if (globalCount) counts.set('ALL', globalCount)
        if (snapshot.category && scopedCount) counts.set(snapshot.category, scopedCount)
        const errors = failures.map(error => notificationErrorMessage(error))
        if (subscriptionError) errors.unshift(subscriptionError)
        dispatch({ type: 'finish', id, page, unreadCount, categoryUnreadCount, error: errors.length ? [...new Set(errors)].join('；') : null })
      } catch (error) {
        if (active) {
          recordFailures([error])
          if (snapshotRevision === revision) dispatch({ type: 'finish', id, error: notificationErrorMessage(error) })
        }
      } finally {
        inFlight = false
        arm()
      }
    }

    function invalidate(delay = 150) {
      revision++
      dispatch({ type: 'invalidate' })
      schedule(delay)
    }
    queryRef.current = next => { query = next; invalidate() }
    refreshRef.current = (forceCounts = false) => {
      if (forceCounts) counts.clear()
      if (Math.max(cooldownUntil.current, retryAt) <= Date.now()) retryAttempt = 0
      invalidate()
    }
    failureRef.current = error => {
      recordFailures([error])
      arm()
    }
    try {
      unsubscribe = getAPI().onNotificationUpdate(event => {
        if (!active) return
        const delay = Math.max(350, lastRefreshAt + EVENT_REFRESH_MS - Date.now())
        if (event?.type === 'resync') { counts.clear(); invalidate(delay); return }
        const parsed = notificationSocketMessageSchema.safeParse(event)
        if (!parsed.success || parsed.data.type === 'pong') return
        if (parsed.data.type === 'notification') {
          const item = parsed.data.data
          const fingerprint = notificationFingerprint(item)
          if (seen.get(item.id) === fingerprint) return
          seen.delete(item.id)
          seen.set(item.id, fingerprint)
          if (seen.size > 200) seen.delete(seen.keys().next().value!)
          counts.delete('ALL')
          counts.delete(item.category)
          dispatch({ type: 'push', notification: item })
        }
        if (parsed.data.type === 'connected' || parsed.data.type === 'unread_count') {
          const count = parsed.data.type === 'connected' ? parsed.data.data.unreadCount : parsed.data.data.count
          const previous = counts.get('ALL')
          counts.set('ALL', { count, at: Date.now() })
          // Repeated identical counts do not require another REST reconciliation.
          if (parsed.data.type === 'unread_count' && previous?.count === count) return
          for (const key of counts.keys()) if (key !== 'ALL') counts.delete(key)
          dispatch({ type: 'count', count })
        }
        invalidate(delay)
      })
    } catch (error) {
      subscriptionError = notificationErrorMessage(error)
    }
    const onFocus = () => { if (Date.now() - lastRefreshAt >= COUNT_FRESH_MS) schedule() }
    window.addEventListener('focus', onFocus)
    return () => {
      active = false
      mounted.current = false
      lifetime.current = owner + 1
      if (timer !== undefined) clearTimeout(timer)
      window.removeEventListener('focus', onFocus)
      unsubscribe?.()
      refreshRef.current = () => undefined
      queryRef.current = () => undefined
      failureRef.current = () => undefined
    }
  }, [])

  useEffect(() => { queryRef.current({ category, unreadOnly, offset }) }, [category, unreadOnly, offset])

  const runMutation = useCallback(async (command: () => Promise<void>, remote = false) => {
    if (mutationLock.current || !mounted.current) return
    if (remote && cooldownUntil.current > Date.now()) {
      dispatch({ type: 'mutation', pending: false, error: notificationErrorMessage({ code: 'RATE_LIMITED' }, 'mutation') })
      return
    }
    mutationLock.current = true
    const owner = lifetime.current
    let failure: string | null = null
    dispatch({ type: 'mutation', pending: true, error: null })
    try {
      await command()
      if (remote && mounted.current && lifetime.current === owner) refreshRef.current(true)
    } catch (error) {
      failure = notificationErrorMessage(error, 'mutation')
      if (remote && mounted.current && lifetime.current === owner) failureRef.current(error)
    } finally {
      mutationLock.current = false
      if (mounted.current && lifetime.current === owner) dispatch({ type: 'mutation', pending: false, error: failure })
    }
  }, [])

  const command = useCallback((operation: (api: ElectronAPI) => Promise<IpcCommandResult>, remote = true) =>
    runMutation(async () => assertNotificationCommand(await operation(getAPI())), remote), [runMutation])
  const categoryQuery = category ? { category } : undefined

  return {
    state,
    setCategory: (value?: NotificationCategory) => dispatch({ type: 'query', query: { category: value, unreadOnly: false, offset: 0 } }),
    setUnreadOnly: (value: boolean) => dispatch({ type: 'query', query: { category, unreadOnly: value, offset: 0 } }),
    setOffset: (value: number) => dispatch({ type: 'query', query: { category, unreadOnly, offset: Math.max(0, Math.floor(value / NOTIFICATION_PAGE_SIZE) * NOTIFICATION_PAGE_SIZE) } }),
    retry: () => refreshRef.current(true),
    markRead: (id: string) => command(api => api.markNotificationRead(id)),
    markAllRead: () => command(api => api.markAllNotificationsRead(categoryQuery)),
    deleteNotification: (id: string) => command(api => api.deleteNotification(id)),
    clearRead: () => command(api => api.clearReadNotifications(categoryQuery)),
    openAll: () => command(api => api.openNotificationAction('/notifications'), false),
    openAction: (notification: PlatformNotification, callback?: (item: PlatformNotification) => void | Promise<void>) => runMutation(async () => {
      if (callback) await callback(notification)
      else if (notification.actionUrl) assertNotificationCommand(await getAPI().openNotificationAction(notification.actionUrl))
    }),
  }
}
