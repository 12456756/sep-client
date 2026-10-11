import * as assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { it } from 'node:test'
import type { NotificationUpdate } from '../../../src/shared/notification-contracts'
import { NotificationSocket } from './notification-socket'
import type { NotificationSocketOptions } from './notification-socket'

class FakeSocket extends EventEmitter {
  sent: unknown[] = []
  terminated = 0
  send(data: string): void { this.sent.push(JSON.parse(data)) }
  terminate(): void { this.terminated++; this.emit('close', 1006, Buffer.alloc(0)) }
  open(): void { this.emit('open') }
  message(data: unknown): void { this.emit('message', Buffer.from(JSON.stringify(data)), false) }
  close(code = 1006, reason = ''): void { this.emit('close', code, Buffer.from(reason)) }
}

class FakeClock {
  time = 0
  nextId = 0
  jobs = new Map<number, { at: number; callback: () => void }>()
  schedule = (callback: () => void, delay: number): (() => void) => {
    const id = ++this.nextId
    this.jobs.set(id, { at: this.time + delay, callback })
    return () => { this.jobs.delete(id) }
  }
  now = (): number => this.time
  tick(ms: number): void {
    const until = this.time + ms
    while (true) {
      const next = [...this.jobs].filter(([, job]) => job.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      this.time = next[1].at
      this.jobs.delete(next[0])
      next[1].callback()
    }
    this.time = until
  }
}

function gate<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function flush(): Promise<void> { for (let i = 0; i < 8; i++) await Promise.resolve() }

function harness(options: Partial<NotificationSocketOptions> = {}) {
  const clock = new FakeClock()
  const sockets: FakeSocket[] = []
  const urls: string[] = []
  const updates: NotificationUpdate[] = []
  const tokenCalls: (boolean | undefined)[] = []
  let token = 'access-1'
  let subscriber: ((token: string | null) => void) | undefined
  let removed = 0
  let authenticationRequired = 0
  const transport = new NotificationSocket({
    baseUrl: 'https://sep.example/api',
    origin: 'https://web.sep.example',
    getAccessToken: async force => { tokenCalls.push(force); return token },
    subscribeAccessToken: callback => { subscriber = callback; return () => { subscriber = undefined; removed++ } },
    onMessage: message => { updates.push(message) },
    onAuthenticationRequired: () => { authenticationRequired++ },
    createSocket: url => { const socket = new FakeSocket(); sockets.push(socket); urls.push(url); return socket },
    schedule: clock.schedule,
    now: clock.now,
    ...options,
  })
  return {
    clock, sockets, urls, updates, tokenCalls, transport,
    rotate: (value: string | null) => { if (value !== null) token = value; subscriber?.(value) },
    get removed() { return removed },
    get authenticationRequired() { return authenticationRequired },
  }
}

async function connect(h: ReturnType<typeof harness>): Promise<FakeSocket> {
  h.transport.start()
  await flush()
  const socket = h.sockets.at(-1)!
  socket.open()
  socket.message({ type: 'connected', data: { unreadCount: 2 }, timestamp: 123 })
  return socket
}

it('derives safe ws/wss URLs and authenticates immediately on open without browser globals', async () => {
  for (const [baseUrl, expected] of [
    ['https://sep.example/api/', 'wss://sep.example/ws/notifications'],
    ['http://localhost:3000/api?token=secret#fragment', 'ws://localhost:3000/ws/notifications'],
    ['https://sep.example/prefix/api/', 'wss://sep.example/prefix/ws/notifications'],
    ['https://sep.example/', 'wss://sep.example/ws/notifications'],
  ]) {
    const h = harness({ baseUrl })
    h.transport.start(); h.transport.start()
    await flush()
    assert.deepEqual(h.urls, [expected])
    assert.deepEqual(h.sockets[0].sent, [])
    h.sockets[0].open()
    assert.deepEqual(h.sockets[0].sent, [{ type: 'auth', token: 'access-1' }])
    h.transport.stop()
  }
  assert.throws(() => harness({ baseUrl: 'file:///api' }))
  assert.throws(() => harness({ baseUrl: 'https://user:password@sep.example/api' }))
})

it('rejects non-HTTP or credential-bearing notification origins', () => {
  for (const origin of ['file:///app', 'wss://sep.example', 'https://user:password@sep.example', 'invalid']) {
    assert.throws(() => harness({ origin }))
  }
})

it('validates unknown messages, ignores pong/binary/malformed input and forwards only safe updates', async () => {
  const h = harness()
  const socket = await connect(h)
  const notification = {
    id: 'n1', userId: 'u1', type: 'INFO', title: 'Title', message: 'Body', read: false,
    category: 'SYSTEM', severity: 'INFO', createdAt: '2026-10-08T00:00:00Z',
  }
  for (const invalid of [null, [], {}, { type: 'unknown' }, { type: 'unread_count', data: { count: -1 } },
    { type: 'notification', data: { ...notification, id: '' } }, { type: 'connected', data: { unreadCount: '2' } }]) socket.message(invalid)
  socket.emit('message', Buffer.from('{not json'), false)
  socket.emit('message', { toString: () => { throw new Error('unsafe payload') } }, false)
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'unread_count', data: { count: 99 } })), true)
  socket.message({ type: 'pong', timestamp: 123 })
  socket.message({ type: 'notification', data: { ...notification, token: 'must-not-forward' }, token: 'secret' })
  socket.message({ type: 'unread_count', data: { count: 3 }, token: 'secret' })
  assert.deepEqual(h.updates, [
    { type: 'connected', data: { unreadCount: 2 } },
    { type: 'notification', data: { ...notification, relatedType: null, relatedId: null, actionUrl: null } },
    { type: 'unread_count', data: { count: 3 } },
  ])
  h.transport.stop()
})

it('sends 30-second heartbeat and reconnects when its pong watchdog expires', async () => {
  const h = harness()
  const socket = await connect(h)
  h.clock.tick(29_999)
  assert.equal(socket.sent.length, 1)
  h.clock.tick(1)
  assert.deepEqual(socket.sent[1], { type: 'ping', timestamp: 30_000 })
  socket.message({ type: 'pong' })
  h.clock.tick(30_000)
  assert.deepEqual(socket.sent[2], { type: 'ping', timestamp: 60_000 })
  h.clock.tick(10_000)
  assert.equal(socket.terminated, 1)
  h.clock.tick(1_000); await flush()
  assert.equal(h.sockets.length, 2)
  assert.equal(h.updates.length, 1)
  h.transport.stop()
  assert.equal(h.clock.jobs.size, 0)
})

it('reconnects with fresh auth and capped exponential delay, resetting only after connected for REST resync', async () => {
  const h = harness()
  let socket = await connect(h)
  socket.close()
  for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
    const count = h.sockets.length
    h.clock.tick(delay - 1); await flush()
    assert.equal(h.sockets.length, count)
    h.clock.tick(1); await flush()
    assert.equal(h.sockets.length, count + 1)
    socket = h.sockets.at(-1)!
    socket.open()
    socket.close()
  }
  h.clock.tick(30_000); await flush()
  socket = h.sockets.at(-1)!
  socket.open(); socket.message({ type: 'connected', data: { unreadCount: 4 } })
  assert.deepEqual(h.updates.at(-1), { type: 'connected', data: { unreadCount: 4 } })
  assert.equal(h.tokenCalls.length, h.sockets.length)
  socket.close(); h.clock.tick(1_000); await flush()
  assert.equal(h.sockets.length, 10)
  h.transport.stop()
})

it('coalesces error/close and reconnects after socket factory/send exceptions', async () => {
  const h = harness()
  let socket = await connect(h)
  socket.emit('error', new Error('raw sensitive details'))
  h.clock.tick(1_000); await flush()
  assert.equal(h.sockets.length, 2)
  socket = h.sockets[1]
  socket.send = () => { throw new Error('send failed') }
  socket.open()
  h.clock.tick(2_000); await flush()
  assert.equal(h.sockets.length, 3)
  h.transport.stop()

  let attempts = 0
  const failedFactory = harness({ createSocket: () => { attempts++; throw new Error('factory failed') } })
  failedFactory.transport.start(); await flush()
  failedFactory.clock.tick(1_000); await flush()
  assert.equal(attempts, 2)
  failedFactory.transport.stop()
})

it('refreshes once for socket authentication rejection then backs off without logging out or rotating again', async () => {
  for (const rejection of [
    (socket: FakeSocket) => socket.emit('unexpected-response', {}, { statusCode: 401 }),
    (socket: FakeSocket) => socket.close(4401),
    (socket: FakeSocket) => socket.close(1008, 'Invalid token'),
    (socket: FakeSocket) => socket.close(1008, 'Authentication required'),
  ]) {
    const calls: (boolean | undefined)[] = []
    const h = harness({ getAccessToken: async force => { calls.push(force); return force ? 'refreshed' : 'expired' } })
    h.transport.start(); await flush()
    rejection(h.sockets[0]); await flush()
    assert.deepEqual(calls, [false, true])
    assert.equal(h.sockets.length, 2)
    h.sockets[1].open()
    assert.deepEqual(h.sockets[1].sent, [{ type: 'auth', token: 'refreshed' }])
    rejection(h.sockets[1]); await flush()
    assert.equal(h.authenticationRequired, 0)
    assert.equal(h.sockets.length, 2)
    assert.equal(h.clock.jobs.size, 1)
    assert.equal(h.removed, 0)
    for (let attempt = 0; attempt < 3; attempt++) {
      h.clock.tick(1_000 * 2 ** attempt); await flush()
      assert.equal(h.sockets.length, 3 + attempt)
      h.sockets.at(-1)!.open()
      rejection(h.sockets.at(-1)!); await flush()
      assert.equal(h.authenticationRequired, 0)
      assert.equal(h.clock.jobs.size, 1)
    }
    assert.equal(calls.filter(Boolean).length, 1)
    h.transport.stop()
    assert.equal(h.clock.jobs.size, 0)
  }
})

it('does not refresh for Origin/policy/timeout rejection or non-401 HTTP failures', async () => {
  for (const rejection of [
    (s: FakeSocket) => s.close(1008, 'Origin not allowed'),
    (s: FakeSocket) => s.close(1008, 'Authentication timeout'),
    (s: FakeSocket) => s.close(1008, 'Other policy'),
    (s: FakeSocket) => s.emit('unexpected-response', {}, { statusCode: 503 }),
  ]) {
    const h = harness()
    h.transport.start(); await flush()
    rejection(h.sockets[0]); await flush()
    assert.deepEqual(h.tokenCalls, [false])
    h.clock.tick(1_000); await flush()
    assert.equal(h.sockets.length, 2)
    h.transport.stop()
  }
})

it('recovers after repeated socket rejection and still handles a later session invalidation', async () => {
  const h = harness()
  h.transport.start(); await flush()
  h.sockets[0].close(4401); await flush()
  h.sockets[1].close(4401); await flush()
  assert.equal(h.authenticationRequired, 0)
  h.clock.tick(1_000); await flush()
  const recovered = h.sockets[2]
  recovered.open()
  recovered.message({ type: 'connected', data: { unreadCount: 1 } })
  assert.deepEqual(h.updates, [{ type: 'connected', data: { unreadCount: 1 } }])
  recovered.close(4401); await flush()
  assert.equal(h.tokenCalls.filter(Boolean).length, 2)
  assert.equal(h.authenticationRequired, 0)
  h.rotate(null)
  assert.equal(h.authenticationRequired, 1)
  assert.equal(h.removed, 1)
  assert.equal(h.clock.jobs.size, 0)
})

it('refreshes token acquisition 401 once, fails closed on rejected refresh, retries other token errors', async () => {
  for (const error of [{ statusCode: 401 }, { status: 401 }]) {
    const calls: (boolean | undefined)[] = []
    const h = harness({ getAccessToken: async force => { calls.push(force); throw force ? { statusCode: 401 } : error } })
    h.transport.start(); await flush()
    assert.deepEqual(calls, [false, true])
    assert.equal(h.authenticationRequired, 1)
    assert.equal(h.sockets.length, 0)
    assert.equal(h.clock.jobs.size, 0)
  }
  const h = harness({ getAccessToken: async () => { throw new Error('offline') } })
  h.transport.start(); await flush()
  h.clock.tick(1_000); await flush()
  assert.equal(h.authenticationRequired, 0)
  assert.equal(h.clock.jobs.size, 1)
  h.transport.stop()
})

it('immediately reauthenticates on token rotation and ignores old socket events / duplicate tokens', async () => {
  const h = harness()
  const old = await connect(h)
  const staleCallbacks = old.listeners('message')
  h.rotate('access-2'); await flush()
  assert.equal(old.terminated, 1)
  assert.equal(old.eventNames().length, 0)
  h.sockets[1].open()
  assert.deepEqual(h.sockets[1].sent, [{ type: 'auth', token: 'access-2' }])
  h.rotate('access-2'); await flush()
  assert.equal(h.sockets.length, 2)
  for (const callback of staleCallbacks) callback(Buffer.from(JSON.stringify({ type: 'unread_count', data: { count: 99 } })), false)
  assert.equal(h.updates.length, 1)
  h.rotate(null)
  assert.equal(h.sockets[1].terminated, 1)
  assert.equal(h.authenticationRequired, 1)
  assert.equal(h.removed, 1)
  assert.equal(h.clock.jobs.size, 0)
})

it('does not double-connect when getAccessToken refresh emits a token subscription', async () => {
  const h = harness({ getAccessToken: async force => { if (force) h.rotate('rotated'); return force ? 'rotated' : 'expired' } })
  h.transport.start(); await flush()
  h.sockets[0].close(1008, 'Invalid token'); await flush()
  assert.equal(h.sockets.length, 2)
  h.sockets[1].open()
  assert.deepEqual(h.sockets[1].sent, [{ type: 'auth', token: 'rotated' }])
  h.transport.stop()
})

it('handles synchronous initial token subscription without a second connection', async () => {
  const h = harness({ subscribeAccessToken: callback => { callback('initial'); return () => {} } })
  h.transport.start(); await flush()
  assert.equal(h.sockets.length, 1)
  assert.equal(h.tokenCalls.length, 0)
  h.sockets[0].open()
  assert.deepEqual(h.sockets[0].sent, [{ type: 'auth', token: 'initial' }])
  h.transport.stop()
})

it('stop removes timers/listeners/subscription and isolates stale token completions across restart', async () => {
  const pending = gate<string>()
  let calls = 0
  const h = harness({ getAccessToken: () => ++calls === 1 ? pending.promise : Promise.resolve('account-2') })
  h.transport.start()
  h.transport.stop(); h.transport.stop()
  h.transport.start(); await flush()
  pending.resolve('old-account'); await flush()
  assert.equal(h.sockets.length, 1)
  h.sockets[0].open()
  assert.deepEqual(h.sockets[0].sent, [{ type: 'auth', token: 'account-2' }])
  h.transport.stop()
  assert.equal(h.sockets[0].eventNames().length, 0)
  assert.equal(h.clock.jobs.size, 0)
  assert.equal(h.removed, 2)
  h.clock.tick(120_000); await flush()
  assert.equal(h.sockets.length, 1)
  assert.equal(h.authenticationRequired, 0)
})

it('ignores stale refresh rejection after token rotation/account switch and after stop', async () => {
  for (const stop of [false, true]) {
    const refresh = gate<string>()
    const h = harness({ getAccessToken: force => force ? refresh.promise : Promise.resolve('old') })
    h.transport.start(); await flush()
    h.sockets[0].close(4401); await flush()
    if (stop) h.transport.stop()
    else h.rotate('new-account')
    refresh.reject(new Error('old account refresh failed')); await flush()
    assert.equal(h.authenticationRequired, 0)
    assert.equal(h.sockets.length, stop ? 1 : 2)
    h.transport.stop()
  }
})

it('times out stalled token acquisition, connection opening and server authentication', async () => {
  const pending = gate<string>()
  let calls = 0
  const h = harness({ getAccessToken: () => ++calls === 1 ? pending.promise : Promise.resolve('new') })
  h.transport.start(); h.clock.tick(10_000)
  h.clock.tick(1_000); await flush()
  pending.resolve('stale'); await flush()
  assert.equal(h.sockets.length, 1)
  assert.equal(h.sockets[0].sent.length, 0)
  h.clock.tick(10_000)
  assert.equal(h.sockets[0].terminated, 1)
  h.clock.tick(2_000); await flush()
  h.sockets[1].open()
  h.clock.tick(10_000)
  assert.equal(h.sockets[1].terminated, 1)
  h.transport.stop()
})

it('sends the configured trusted Origin without token handshake headers and stops a pending handshake safely', async () => {
  // An HTTP server is sufficient to inspect the real ws handshake and then reject it.
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const requests: { url: string | undefined; origin: string | undefined; authorization: string | undefined; protocol: string | undefined }[] = []
  const upgraded = gate<void>()
  const peers = new Set<import('node:net').Socket>()
  server.on('connection', peer => { peers.add(peer); peer.on('close', () => peers.delete(peer)) })
  server.on('upgrade', req => {
    requests.push({ url: req.url, origin: req.headers.origin, authorization: req.headers.authorization, protocol: req.headers['sec-websocket-protocol'] })
    upgraded.resolve()
  })
  const transport = new NotificationSocket({
    baseUrl: `http://127.0.0.1:${address.port}/api?token=secret`,
    origin: 'https://web.sep.example:8443/path?ignored=true',
    getAccessToken: async () => 'secret-access',
    onMessage: () => { assert.fail('no established socket') },
    onAuthenticationRequired: () => { assert.fail('not an auth rejection') },
  })
  try {
    transport.start()
    await upgraded.promise
    transport.stop()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(requests, [{ url: '/ws/notifications', origin: 'https://web.sep.example:8443', authorization: undefined, protocol: undefined }])
  } finally {
    transport.stop()
    for (const peer of peers) peer.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})


it('ignores retired subscription callbacks after a new account starts', async () => {
  const callbacks: ((token: string | null) => void)[] = []
  const h = harness({ subscribeAccessToken: callback => { callbacks.push(callback); return () => {} } })
  await connect(h)
  h.transport.stop()
  h.transport.start(); await flush()
  const current = h.sockets[1]
  callbacks[0]('retired-account')
  callbacks[0](null)
  await flush()
  assert.equal(h.authenticationRequired, 0)
  assert.equal(h.sockets.length, 2)
  assert.equal(current.terminated, 0)
  h.transport.stop()
})

it('guards cancelled heartbeat/retry callbacks even when already queued by the clock', async () => {
  const scheduled: (() => void)[] = []
  const clock = new FakeClock()
  const h = harness({ schedule: (callback, delay) => { scheduled.push(callback); return clock.schedule(callback, delay) } })
  const old = await connect(h)
  const oldHeartbeat = scheduled.at(-1)!
  h.rotate('new-account'); await flush()
  const current = h.sockets[1]
  current.open(); current.message({ type: 'connected', data: { unreadCount: 0 } })
  oldHeartbeat()
  h.transport.stop()
  assert.equal(clock.jobs.size, 0)
  assert.equal(old.terminated, 1)

  const retryCallbacks: (() => void)[] = []
  const retryClock = new FakeClock()
  const retry = harness({ schedule: (callback, delay) => { retryCallbacks.push(callback); return retryClock.schedule(callback, delay) } })
  const first = await connect(retry)
  first.close()
  const oldRetry = retryCallbacks.at(-1)!
  retry.rotate('new'); await flush()
  retry.sockets[1].close()
  oldRetry()
  retry.transport.stop()
  assert.equal(retryClock.jobs.size, 0)
})

it('fetches a fresh token on network reconnect instead of reusing the last socket token', async () => {
  let token = 'first'
  const h = harness({ getAccessToken: async () => token })
  const first = await connect(h)
  token = 'second'
  first.close()
  h.clock.tick(1_000); await flush()
  h.sockets[1].open()
  assert.deepEqual(h.sockets[1].sent, [{ type: 'auth', token: 'second' }])
  h.transport.stop()
})

it('fails closed on empty token / synchronous logout subscription', async () => {
  const empty = harness({ getAccessToken: async () => '' })
  empty.transport.start(); await flush()
  assert.equal(empty.authenticationRequired, 1)
  assert.equal(empty.sockets.length, 0)
  assert.equal(empty.clock.jobs.size, 0)

  let unsubscribe = 0
  const loggedOut = harness({ subscribeAccessToken: callback => { callback(null); return () => { unsubscribe++ } } })
  loggedOut.transport.start(); await flush()
  assert.equal(loggedOut.authenticationRequired, 1)
  assert.equal(unsubscribe, 1)
  assert.equal(loggedOut.sockets.length, 0)

})

it('retries transient forced refresh failures without clearing the authenticated session', async () => {
  for (const failure of [new TypeError('fetch failed'), { statusCode: 503 }]) {
    const calls: (boolean | undefined)[] = []
    let refreshAttempts = 0
    const h = harness({ getAccessToken: async force => {
      calls.push(force)
      if (!force) return 'expired'
      if (++refreshAttempts === 1) throw failure
      return 'refreshed'
    } })
    h.transport.start(); await flush()
    h.sockets[0].close(4401); await flush()
    assert.equal(h.authenticationRequired, 0)
    assert.deepEqual(calls, [false, true])
    h.clock.tick(1_000); await flush()
    assert.deepEqual(calls, [false, true, true])
    const replacement = h.sockets[1]
    replacement.open()
    replacement.message({ type: 'connected', data: { unreadCount: 0 } })
    assert.deepEqual(replacement.sent, [{ type: 'auth', token: 'refreshed' }])
    assert.equal(h.authenticationRequired, 0)
    h.transport.stop()
  }
})

it('retries stalled forced refresh and ignores late results from the timed out attempt', async () => {
  const pending = gate<string>()
  const calls: (boolean | undefined)[] = []
  let refreshAttempts = 0
  const h = harness({ getAccessToken: force => {
    calls.push(force)
    if (!force) return Promise.resolve('expired')
    return ++refreshAttempts === 1 ? pending.promise : Promise.resolve('refreshed')
  } })
  h.transport.start(); await flush()
  h.sockets[0].close(4401); await flush()
  h.clock.tick(10_000)
  assert.equal(h.authenticationRequired, 0)
  pending.resolve('too-late'); await flush()
  assert.equal(h.sockets.length, 1)
  h.clock.tick(1_000); await flush()
  assert.deepEqual(calls, [false, true, true])
  assert.equal(h.sockets.length, 2)
  h.sockets[1].open()
  assert.deepEqual(h.sockets[1].sent, [{ type: 'auth', token: 'refreshed' }])
  h.transport.stop()
  assert.equal(h.clock.jobs.size, 0)
})

it('keeps a second socket auth rejection local after refresh publishes and ignores the late refresh result', async () => {
  for (const reject of [
    (socket: FakeSocket) => socket.emit('unexpected-response', {}, { statusCode: 401 }),
    (socket: FakeSocket) => socket.close(4401),
    (socket: FakeSocket) => socket.close(1008, 'Invalid token'),
  ]) {
    const pendingRefresh = gate<string>()
    const calls: (boolean | undefined)[] = []
    const h = harness({ getAccessToken: force => {
      calls.push(force)
      if (!force) return Promise.resolve('expired')
      // AuthSessionManager publishes before its refresh promise settles.
      h.rotate('published-refresh')
      return pendingRefresh.promise
    } })
    h.transport.start(); await flush()
    const old = h.sockets[0]
    old.open()
    old.close(1008, 'Invalid token'); await flush()
    assert.deepEqual(calls, [false, true])
    assert.equal(old.eventNames().length, 0)
    assert.equal(h.sockets.length, 2)
    const replacement = h.sockets[1]
    replacement.open()
    assert.deepEqual(replacement.sent, [{ type: 'auth', token: 'published-refresh' }])
    reject(replacement); await flush()
    assert.equal(h.authenticationRequired, 0)
    assert.equal(h.removed, 0)
    assert.equal(replacement.eventNames().length, 0)
    assert.equal(h.clock.jobs.size, 1)
    pendingRefresh.resolve('published-refresh'); await flush()
    assert.deepEqual(calls, [false, true])
    assert.equal(h.sockets.length, 2)
    h.clock.tick(1_000); await flush()
    assert.deepEqual(calls, [false, true, false])
    assert.equal(h.sockets.length, 3)
    const recovered = h.sockets[2]
    recovered.open()
    recovered.message({ type: 'connected', data: { unreadCount: 2 } })
    assert.equal(h.authenticationRequired, 0)
    assert.equal(h.removed, 0)
    h.transport.stop()
    assert.equal(h.clock.jobs.size, 0)
  }
})

it('token publication cancels an existing reconnect and all retired socket callbacks stay inert', async () => {
  const h = harness()
  const old = await connect(h)
  const retired = new Map(old.eventNames().map(event => [event, old.listeners(event)]))
  old.emit('error', new Error('connection failure'))
  assert.equal(old.eventNames().length, 0)
  h.rotate('published-token'); await flush()
  assert.equal(h.sockets.length, 2)
  const current = h.sockets[1]
  current.open()
  current.message({ type: 'connected', data: { unreadCount: 7 } })
  for (const listener of retired.get('open') ?? []) listener()
  for (const listener of retired.get('error') ?? []) listener(new Error('late failure'))
  for (const listener of retired.get('close') ?? []) listener(4401, Buffer.alloc(0))
  for (const listener of retired.get('unexpected-response') ?? []) listener({}, { statusCode: 401 })
  for (const listener of retired.get('message') ?? []) listener(Buffer.from(JSON.stringify({ type: 'unread_count', data: { count: 999 } })), false)
  h.clock.tick(1_000); await flush()
  assert.equal(h.sockets.length, 2)
  assert.equal(current.terminated, 0)
  assert.equal(h.authenticationRequired, 0)
  assert.deepEqual(h.updates, [
    { type: 'connected', data: { unreadCount: 2 } },
    { type: 'connected', data: { unreadCount: 7 } },
  ])
  h.transport.stop()
  assert.equal(current.eventNames().length, 0)
  assert.equal(h.clock.jobs.size, 0)
})
