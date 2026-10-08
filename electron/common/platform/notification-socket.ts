import WebSocket from 'ws'
import { notificationSocketMessageSchema } from '../../../src/shared/notification-contracts'
import type { NotificationUpdate } from '../../../src/shared/notification-contracts'

/** Node ws event surface, also implemented by deterministic test sockets. */
export interface NotificationWebSocket {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  off(event: string, listener: (...args: unknown[]) => void): unknown
  send(data: string): void
  terminate(): void
}

export interface NotificationSocketOptions {
  baseUrl: string
  getAccessToken: (forceRefresh?: boolean) => Promise<string>
  subscribeAccessToken?: (callback: (token: string | null) => void) => () => void
  onMessage: (message: NotificationUpdate) => void
  onAuthenticationRequired: () => void
  createSocket?: (url: string) => NotificationWebSocket
  /** Returns a cancellation function; all deadlines use this clock. */
  schedule?: (callback: () => void, delayMs: number) => () => void
  now?: () => number
}

type Listener = (...args: unknown[]) => void
interface Connection {
  socket: NotificationWebSocket
  listeners: [string, Listener][]
  opened: boolean
  authenticated: boolean
}

const CONNECT_TIMEOUT_MS = 10_000
const HEARTBEAT_MS = 30_000
const PONG_TIMEOUT_MS = 10_000
const MAX_RECONNECT_MS = 30_000

function socketUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Notification base URL must be HTTP(S) without credentials')
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/api$/, '') + '/ws/notifications'
  url.search = ''
  url.hash = ''
  return url.toString()
}

function textPayload(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString('utf8')
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8')
  return undefined
}

function isUnauthorized(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (
    ('statusCode' in value && value.statusCode === 401) || ('status' in value && value.status === 401)
  )
}

/**
 * Notification-only transport. Every authenticated `connected` update is forwarded
 * so the owning service can REST-resync; neither credentials nor raw errors escape.
 * Uses Node ws rather than Electron 33 / Node 20's absent global WebSocket.
 */
export class NotificationSocket {
  private readonly url: string
  private readonly createSocket: (url: string) => NotificationWebSocket
  private readonly schedule: (callback: () => void, delayMs: number) => () => void
  private readonly now: () => number
  private running = false
  private generation = 0
  private subscriptionGeneration = 0
  private connection?: Connection
  private unsubscribe?: () => void
  private cancelAttempt?: () => void
  private cancelRetry?: () => void
  private cancelHeartbeat?: () => void
  private cancelWatchdog?: () => void
  private reconnectMs = 1_000
  private refreshed = false
  private currentToken: string | null = null

  constructor(private readonly options: NotificationSocketOptions) {
    this.url = socketUrl(options.baseUrl)
    // ws is deliberately bundled from the installed transitive dependency. No Origin,
    // Authorization headers, URL credentials, subprotocol tokens or redirects.
    this.createSocket = options.createSocket ?? (url => new WebSocket(url, {
      maxPayload: 1024 * 1024,
      followRedirects: false,
    }))
    this.schedule = options.schedule ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs)
      timer.unref()
      return () => clearTimeout(timer)
    })
    this.now = options.now ?? Date.now
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.refreshed = false
    this.reconnectMs = 1_000
    const generation = ++this.generation
    const subscriptionGeneration = ++this.subscriptionGeneration
    if (this.options.subscribeAccessToken) {
      const unsubscribe = this.options.subscribeAccessToken(token => {
        if (!this.running || this.subscriptionGeneration !== subscriptionGeneration) return
        if (!token) { this.requireAuthentication(); return }
        if (token === this.currentToken) return
        // A subscription emitted inside a refresh wins over that refresh's pending
        // promise. Its generation invalidates the promise, preventing two sockets.
        this.connect(token)
      })
      // A subscription may synchronously announce logout and stop us.
      if (this.running && this.subscriptionGeneration === subscriptionGeneration) this.unsubscribe = unsubscribe
      else unsubscribe()
    }
    if (this.isCurrent(generation)) this.connect()
  }

  stop(): void {
    this.running = false
    ++this.subscriptionGeneration
    ++this.generation
    this.disconnect()
    this.cancelRetry?.()
    this.cancelRetry = undefined
    const unsubscribe = this.unsubscribe
    this.unsubscribe = undefined
    unsubscribe?.()
    this.currentToken = null
    this.refreshed = false
  }

  private isCurrent(generation: number): boolean {
    return this.running && this.generation === generation
  }

  private connect(token?: string, forceRefresh = false): void {
    if (!this.running) return
    const generation = ++this.generation
    this.disconnect()
    this.cancelRetry?.()
    this.cancelRetry = undefined
    if (token !== undefined) this.currentToken = token
    this.cancelAttempt = this.schedule(() => {
      if (!this.isCurrent(generation)) return
      this.retry(generation, forceRefresh)
    }, CONNECT_TIMEOUT_MS)
    void this.obtainToken(generation, token, forceRefresh)
  }

  private async obtainToken(generation: number, suppliedToken: string | undefined, forceRefresh: boolean): Promise<void> {
    let token: string
    try {
      token = suppliedToken ?? await this.options.getAccessToken(forceRefresh)
    } catch (error: unknown) {
      if (!this.isCurrent(generation)) return
      if (isUnauthorized(error)) {
        if (forceRefresh) this.requireAuthentication()
        else this.refreshAuthentication(generation)
      } else {
        // A refresh request can fail while the session is still valid. Keep the
        // forced refresh intent so a retry cannot reuse the rejected access token.
        this.retry(generation, forceRefresh)
      }
      return
    }
    if (!this.isCurrent(generation)) return
    if (typeof token !== 'string' || !token.trim()) { this.requireAuthentication(); return }
    this.currentToken = token
    let socket: NotificationWebSocket
    try {
      socket = this.createSocket(this.url)
    } catch {
      this.retry(generation)
      return
    }
    const connection: Connection = { socket, listeners: [], opened: false, authenticated: false }
    this.connection = connection
    const listen = (event: string, listener: Listener): void => {
      const guarded: Listener = (...args) => {
        if (this.isCurrent(generation) && this.connection === connection) listener(...args)
      }
      connection.listeners.push([event, guarded])
      socket.on(event, guarded)
    }
    listen('open', () => {
      if (connection.opened) return
      connection.opened = true
      this.cancelAttempt?.()
      this.cancelAttempt = this.schedule(() => this.retry(generation), CONNECT_TIMEOUT_MS)
      this.send(connection, generation, { type: 'auth', token })
    })
    listen('message', (raw, isBinary) => this.receive(connection, generation, raw, isBinary))
    listen('error', () => this.retry(generation))
    listen('close', (code, rawReason) => {
      const reason = textPayload(rawReason)
      // Backend: notifications.gateway.ts. Other 1008 policy errors are not JWT
      // failures and must not consume/rotate the refresh token.
      const authRejected = code === 4401 || (code === 1008 && (
        reason === 'Invalid token' || reason === 'Authentication required'
      ))
      this.disconnect(true)
      if (authRejected) this.refreshAuthentication(generation)
      else this.retry(generation)
    })
    listen('unexpected-response', (_request, response) => {
      // Installing this listener makes ws leave HTTP rejection cleanup to us;
      // disconnect/terminate aborts the request instead of leaving it open.
      if (isUnauthorized(response)) this.refreshAuthentication(generation)
      else this.retry(generation)
    })
  }

  private receive(connection: Connection, generation: number, raw: unknown, isBinary: unknown): void {
    if (!connection.opened || isBinary === true) return
    const text = textPayload(raw)
    if (text === undefined) return
    let input: unknown
    try { input = JSON.parse(text) } catch { return }
    const result = notificationSocketMessageSchema.safeParse(input)
    if (!result.success) return
    const message = result.data
    if (message.type === 'pong') {
      this.cancelWatchdog?.()
      this.cancelWatchdog = undefined
      return
    }
    if (message.type === 'connected') {
      connection.authenticated = true
      this.refreshed = false
      this.reconnectMs = 1_000
      this.cancelAttempt?.()
      this.cancelAttempt = undefined
      if (!this.cancelHeartbeat) this.heartbeat(connection, generation)
    } else if (!connection.authenticated) return
    this.options.onMessage(message)
  }

  private heartbeat(connection: Connection, generation: number): void {
    this.cancelHeartbeat = this.schedule(() => {
      if (!this.isCurrent(generation) || this.connection !== connection) return
      this.cancelHeartbeat = undefined
      this.cancelWatchdog = this.schedule(() => this.retry(generation), PONG_TIMEOUT_MS)
      if (this.send(connection, generation, { type: 'ping', timestamp: this.now() })) {
        this.heartbeat(connection, generation)
      }
    }, HEARTBEAT_MS)
  }

  private send(connection: Connection, generation: number, message: unknown): boolean {
    try { connection.socket.send(JSON.stringify(message)); return true } catch {
      this.retry(generation)
      return false
    }
  }

  private retry(generation: number, forceRefresh = false): void {
    if (!this.isCurrent(generation)) return
    const retryGeneration = ++this.generation
    this.disconnect()
    this.cancelRetry?.()
    const delay = this.reconnectMs
    this.reconnectMs = Math.min(this.reconnectMs * 2, MAX_RECONNECT_MS)
    this.cancelRetry = this.schedule(() => {
      if (!this.isCurrent(retryGeneration)) return
      this.cancelRetry = undefined
      this.connect(undefined, forceRefresh)
    }, delay)
  }

  private refreshAuthentication(generation: number): void {
    if (!this.isCurrent(generation)) return
    if (this.refreshed) { this.requireAuthentication(); return }
    this.refreshed = true
    this.connect(undefined, true)
  }

  private requireAuthentication(): void {
    if (!this.running) return
    this.stop()
    this.options.onAuthenticationRequired()
  }

  private disconnect(alreadyClosed = false): void {
    this.cancelAttempt?.()
    this.cancelAttempt = undefined
    this.cancelHeartbeat?.()
    this.cancelHeartbeat = undefined
    this.cancelWatchdog?.()
    this.cancelWatchdog = undefined
    const connection = this.connection
    this.connection = undefined
    if (!connection) return
    const { socket, listeners } = connection
    for (const [event, listener] of listeners) socket.off(event, listener)
    if (alreadyClosed) return
    // ws.terminate() during CONNECTING emits error/close on nextTick. Leaving it
    // without an error listener would crash Node. These temporary listeners retain
    // only the retired socket (no transport/token/callback), and remove themselves.
    const ignoreError = (): void => {}
    const cleanup = (): void => {
      socket.off('error', ignoreError)
      socket.off('close', cleanup)
    }
    socket.on('error', ignoreError)
    socket.on('close', cleanup)
    socket.terminate()
  }
}
