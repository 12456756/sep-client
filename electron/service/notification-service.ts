import * as platformApi from '../common/platform/platform-api'
import { AuthenticationRequiredError } from '../common/platform/authentication-required-error'
import { requireScope, type ScopeSource } from './scope-guard'
import type { NotificationPage, NotificationQuery, NotificationCategoryQuery, NotificationUpdate } from '../../src/shared/notification-contracts'

type NotificationApi = Pick<typeof platformApi, 'listNotifications' | 'getUnreadNotificationCount' | 'markNotificationRead' | 'markAllNotificationsRead' | 'deleteNotification' | 'clearReadNotifications'>
interface NotificationTransport { start(): void; stop(): void }
export interface NotificationServiceOptions {
  scope: ScopeSource
  getAccessToken: (forceRefresh?: boolean) => Promise<string>
  onAuthenticationRequired: () => void
  onUpdate: (event: NotificationUpdate) => void
  createSocket: (receive: (event: NotificationUpdate) => void) => NotificationTransport
  api?: NotificationApi
  retryDelay?: () => Promise<void>
}

/** Account-scoped access-token requests; the renderer never receives a token. */
export class NotificationService {
  private readonly api: NotificationApi
  private readonly socket: NotificationTransport
  private generation = 0
  private started = false

  constructor(private readonly options: NotificationServiceOptions) {
    this.api = options.api ?? platformApi
    this.socket = options.createSocket(event => {
      const scope = this.options.scope.currentScope()
      if (!this.started || !scope) return
      if (event.type === 'notification' && event.data.userId && event.data.userId !== scope.memberId) return
      this.options.onUpdate(event)
    })
  }

  stop(): void {
    this.generation++
    this.started = false
    this.socket.stop()
  }

  private async request<T>(operation: (token: string) => Promise<T>, retryRead = false): Promise<T> {
    const scope = requireScope(this.options.scope)
    const generation = this.generation
    const isCurrent = (): boolean => {
      const current = this.options.scope.currentScope()
      return generation === this.generation && current?.memberId === scope.memberId && current.enterpriseId === scope.enterpriseId
    }
    const assertCurrent = (): void => { if (!isCurrent()) throw new AuthenticationRequiredError() }
    let refreshed = false
    let retriedRead = false
    try {
      let token = await this.options.getAccessToken()
      assertCurrent()
      for (;;) {
        try {
          const result = await operation(token)
          assertCurrent()
          return result
        } catch (error) {
          assertCurrent()
          if (error instanceof platformApi.AuthApiError && error.isUnauthorized && !refreshed) {
            refreshed = true
            token = await this.options.getAccessToken(true)
            assertCurrent()
            continue
          }
          const transient = (error instanceof platformApi.AuthApiError && error.isNetworkError) || error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError')
          if (retryRead && transient && !retriedRead) {
            retriedRead = true
            await (this.options.retryDelay?.() ?? new Promise<void>(resolve => setTimeout(resolve, 500)))
            assertCurrent()
            continue
          }
          throw error
        }
      }
    } catch (error) {
      if (isCurrent() && error instanceof AuthenticationRequiredError) {
        this.stop()
        this.options.onAuthenticationRequired()
      }
      throw error
    } finally {
      // Start even if REST is offline: a successful reconnect triggers REST compensation.
      if (isCurrent() && !this.started) {
        this.started = true
        this.socket.start()
      }
    }
  }

  list(query: NotificationQuery): Promise<NotificationPage> { return this.request(token => this.api.listNotifications(token, query), true) }
  unreadCount(query: NotificationCategoryQuery): Promise<{ count: number }> { return this.request(token => this.api.getUnreadNotificationCount(token, query), true) }
  private async mutate(operation: (token: string) => Promise<void>): Promise<void> {
    await this.request(operation)
    this.options.onUpdate({ type: 'resync' })
  }
  markRead(id: string): Promise<void> { return this.mutate(token => this.api.markNotificationRead(id, token)) }
  markAllRead(query: NotificationCategoryQuery): Promise<void> { return this.mutate(token => this.api.markAllNotificationsRead(token, query)) }
  delete(id: string): Promise<void> { return this.mutate(token => this.api.deleteNotification(id, token)) }
  clearRead(query: NotificationCategoryQuery): Promise<void> { return this.mutate(token => this.api.clearReadNotifications(token, query)) }
}
