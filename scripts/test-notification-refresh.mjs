/* global window, document */
// Exercise the real hook and panel with controlled IPC and a virtual browser clock.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const server = await createServer({ configFile: 'vite.preview.config.ts', logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } })
let browser
try {
  await server.listen()
  const origin = 'http://127.0.0.1:' + server.httpServer.address().port
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.clock.install({ time: new Date('2026-10-27T10:00:00Z') })
  await page.clock.pauseAt(new Date('2026-10-27T10:00:00Z'))
  await page.goto(origin + '/?preview=workspace')
  const source = await (await page.request.get(origin + '/components/enterprise/NotificationCenter.tsx')).text()
  const main = await (await page.request.get(origin + '/main.tsx')).text()
  const reactPath = source.match(/from "([^"]*\/react\.js[^"]*)"/)[1]
  const domPath = main.match(/from "([^"]*\/react-dom_client\.js[^"]*)"/)[1]
  await page.evaluate(async ({ reactPath, domPath }) => {
    const React = (await import(reactPath)).default
    const { createRoot } = (await import(domPath)).default
    const { useNotifications } = await import('/features/enterprise/use-notifications.ts')
    const { NotificationPanel } = await import('/components/enterprise/NotificationCenter.tsx')
    await import('/styles/notifications.css')
    const e = React.createElement
    const calls = { list: [], count: [], mark: 0 }
    const listeners = new Set()
    const rate = { success: false, error: { code: 'RATE_LIMITED', statusCode: 429, message: 'limited', retryAfterMs: 5000 } }
    let mode = 'success'
    let release
    const item = (id, category = 'SYSTEM') => ({ id, type: 'INFO', title: id, message: '通知内容', category,
      severity: 'INFO', read: false, createdAt: '2026-10-27T09:00:00Z' })
    window.electronAPI = {
      listNotifications: async query => {
        calls.list.push({ ...query, at: Date.now() })
        if (mode === 'held') return new Promise(resolve => { release = resolve })
        return mode === 'rate' ? rate : { success: true, data: { items: [item('已保存通知', query.category)], total: 101 } }
      },
      getUnreadNotificationCount: async query => { calls.count.push(query?.category ?? 'ALL'); return { success: true, data: { count: 3 } } },
      onNotificationUpdate: listener => { listeners.add(listener); return () => listeners.delete(listener) },
      markNotificationRead: async () => { calls.mark++; return mode === 'mutation-rate' ? rate : { success: true } },
    }
    function Harness() {
      const notifications = useNotifications()
      window.notificationTest = { ...notifications, calls,
        mode: value => { mode = value }, emit: event => { for (const listener of listeners) listener(event) },
        releaseRate: () => release(rate), releaseSuccess: () => release({ success: true, data: { items: [], total: 0 } }),
        item, remount: () => mount(value => value + 1) }
      return e(NotificationPanel, { id: 'test-notifications', state: notifications.state,
        onClose() {}, onCategory: notifications.setCategory, onPage: notifications.setOffset,
        onRetry: notifications.retry, onRead: notifications.markRead, onReadAll() {}, onDelete() {}, onViewAll() {}, onAction() {} })
    }
    let mount
    function Scope() {
      const [account, setAccount] = React.useState(0)
      mount = setAccount
      return e(Harness, { key: account })
    }
    window.notificationTestUnmount = () => root.unmount()
    const old = document.getElementById('root')
    old.remove()
    const host = document.createElement('div')
    host.className = 'ent-shell'
    document.body.append(host)
    const root = createRoot(host)
    root.render(e(React.StrictMode, null, e(Scope)))
  }, { reactPath, domPath })
  await page.waitForFunction(() => Boolean(window.notificationTest))
  const tick = async ms => { await page.clock.runFor(ms); await page.evaluate(() => new Promise(resolve => queueMicrotask(resolve))) }
  const settled = async () => page.waitForFunction(() => !window.notificationTest.state.loading)
  await tick(200)
  await settled()
  const before = await page.evaluate(() => window.notificationTest.calls.list.length)
  await page.evaluate(() => { window.notificationTest.mode('rate'); window.notificationTest.retry() })
  await tick(200)
  await settled()
  await page.waitForFunction(() => window.notificationTest.state.cooldownUntil > Date.now())
  assert.equal(await page.getByText('已保存通知', { exact: true }).count(), 1, 'retain cached notifications on 429')
  assert.equal(await page.getByRole('button', { name: '重试加载通知' }).isDisabled(), true)
  assert.match(await page.getByRole('button', { name: '重试加载通知' }).innerText(), /\d+ 秒/)
  await mkdir('output/playwright', { recursive: true })
  await page.locator('#test-notifications').screenshot({ path: 'output/playwright/notification-cooldown.png' })
  await page.evaluate(() => {
    const t = window.notificationTest
    t.setCategory('SYSTEM'); t.retry()
    t.emit({ type: 'unread_count', data: { count: 4 } })
    window.dispatchEvent(new Event('focus'))
  })
  await tick(200)
  await page.evaluate(() => window.notificationTest.setCategory('SECURITY'))
  await page.waitForFunction(() => window.notificationTest.state.query.category === 'SECURITY')
  await page.evaluate(() => { window.notificationTest.setOffset(50); window.notificationTest.retry() })
  await tick(4000)
  assert.equal(await page.evaluate(() => window.notificationTest.calls.list.length), before + 1, 'category, paging, retry, focus and pushes must respect cooldown')
  await page.evaluate(() => window.notificationTest.mode('success'))
  await tick(1000)
  await settled()
  assert.equal(await page.evaluate(() => window.notificationTest.calls.list.length), before + 2, 'one recovery request')
  const recovered = await page.evaluate(() => window.notificationTest.calls.list.at(-1))
  assert.equal(recovered.category, 'SECURITY')
  assert.equal(recovered.offset, 50)
  assert.equal(await page.evaluate(() => window.notificationTest.state.cooldownUntil), 0)
  const counts = await page.evaluate(() => window.notificationTest.calls.count.length)
  await page.evaluate(() => window.notificationTest.setOffset(0))
  await tick(200)
  await settled()
  assert.equal(await page.evaluate(() => window.notificationTest.calls.count.length), counts, 'paging reuses fresh unread counts')
  const beforePush = await page.evaluate(() => window.notificationTest.calls.list.length)
  await page.evaluate(() => {
    const t = window.notificationTest
    for (let index = 0; index < 20; index++) {
      t.emit({ type: 'notification', data: t.item('实时通知' + index, 'SECURITY') })
      t.emit({ type: 'unread_count', data: { count: 10 + index } })
    }
  })
  await page.waitForFunction(() => window.notificationTest.state.unreadCount === 29)
  assert.equal(await page.getByText('实时通知19', { exact: true }).count(), 1, 'pushes render before REST reconciliation')
  await tick(2100)
  await settled()
  assert.equal(await page.evaluate(() => window.notificationTest.calls.list.length), beforePush + 1, 'a burst of pushes produces one reconciliation')
  assert.equal(await page.evaluate(() => window.notificationTest.calls.count.filter(value => value === 'ALL').length),
    await page.evaluate(length => window.notificationTest.calls.count.slice(0, length).filter(value => value === 'ALL').length, counts), 'fresh socket count avoids global count reads')
  await page.evaluate(() => { for (let index = 0; index < 10; index++) window.notificationTest.emit({ type: 'unread_count', data: { count: 29 } }) })
  await tick(2100)
  assert.equal(await page.evaluate(() => window.notificationTest.calls.list.length), beforePush + 1, 'identical counts do not trigger more reads')

  await page.evaluate(() => { window.notificationTest.mode('held'); window.notificationTest.retry() })
  await tick(200)
  const overlapping = await page.evaluate(() => window.notificationTest.calls.list.length)
  await page.evaluate(() => window.notificationTest.emit({ type: 'unread_count', data: { count: 30 } }))
  await tick(200)
  await page.evaluate(() => { window.notificationTest.mode('success'); window.notificationTest.releaseSuccess() })
  await tick(1000)
  assert.equal(await page.evaluate(() => window.notificationTest.calls.list.length), overlapping, 'in-flight completion preserves push coalescing deadline')
  assert.equal(await page.evaluate(() => window.notificationTest.state.unreadCount), 30, 'late REST never overwrites a newer push count')
  await tick(1000)
  await settled()
  assert.equal(await page.evaluate(() => window.notificationTest.calls.list.length), overlapping + 1)

  // Changing filters must neither overlap requests nor hide an obsolete request's 429.
  await page.evaluate(() => { window.notificationTest.mode('held'); window.notificationTest.retry() })
  await tick(200)
  const heldCalls = await page.evaluate(() => window.notificationTest.calls.list.length)
  await page.evaluate(() => window.notificationTest.setCategory('APPROVAL'))
  await tick(200)
  assert.equal(await page.evaluate(() => window.notificationTest.calls.list.length), heldCalls, 'filter switches share the in-flight lock')
  await page.evaluate(() => window.notificationTest.releaseRate())
  await page.waitForFunction(() => window.notificationTest.state.cooldownUntil > Date.now())
  await page.evaluate(() => window.notificationTest.mode('success'))
  await tick(4800)
  assert.equal(await page.evaluate(() => window.notificationTest.calls.list.length), heldCalls)
  await tick(300)
  await settled()
  assert.equal(await page.evaluate(() => window.notificationTest.calls.list.length), heldCalls + 1)
  assert.equal(await page.evaluate(() => window.notificationTest.calls.list.at(-1).category), 'APPROVAL')

  // Mutation failures establish the same cooldown, but never replay a mutation.
  await page.evaluate(async () => { window.notificationTest.mode('mutation-rate'); await window.notificationTest.markRead('saved') })
  await page.waitForFunction(() => window.notificationTest.state.cooldownUntil > Date.now())
  const marked = await page.evaluate(() => window.notificationTest.calls.mark)
  await page.evaluate(async () => { await window.notificationTest.markRead('saved'); window.notificationTest.retry() })
  await tick(1000)
  assert.equal(await page.evaluate(() => window.notificationTest.calls.mark), marked)
  await page.evaluate(() => window.notificationTest.mode('success'))
  await tick(4200)
  await settled()
  assert.equal(await page.evaluate(() => window.notificationTest.calls.mark), marked, 'automatic recovery only reads')
  assert.equal(await page.getByRole('button', { name: '标为已读：已保存通知' }).isEnabled(), true)

  // A new login lifetime owns its own cooldown/cache and ignores old completions.
  await page.evaluate(() => { window.notificationTest.mode('held'); window.notificationTest.retry() })
  await tick(200)
  await page.evaluate(() => { window.notificationTest.mode('success'); window.notificationTest.remount() })
  await tick(200)
  await settled()
  await page.evaluate(() => window.notificationTest.releaseRate())
  await tick(200)
  assert.equal(await page.evaluate(() => window.notificationTest.state.cooldownUntil), 0)
  assert.equal(await page.evaluate(() => window.notificationTest.state.error), null)
  assert.equal(await page.evaluate(() => window.notificationTest.state.query.category), undefined)
  await page.evaluate(() => { window.notificationTest.mode('rate'); window.notificationTest.retry() })
  await tick(200)
  await page.waitForFunction(() => window.notificationTest.state.cooldownUntil > Date.now())
  const firstFailure = await page.evaluate(() => window.notificationTest.calls.list.length)
  for (let attempt = 0; attempt < 3; attempt++) { await tick(5100); await settled() }
  assert.equal(await page.evaluate(() => window.notificationTest.calls.list.length), firstFailure + 3, 'automatic retries are bounded')
  assert.equal(await page.getByRole('button', { name: '重试加载通知' }).isDisabled(), true, 'final 429 still enforces cooldown')
  await tick(10_000)
  assert.equal(await page.evaluate(() => window.notificationTest.calls.list.length), firstFailure + 3, 'no unbounded polling on persistent 429')
  await page.evaluate(() => { window.notificationTest.mode('success'); window.notificationTest.remount() })
  await tick(200)
  await settled()
  assert.equal(await page.evaluate(() => window.notificationTest.state.cooldownUntil), 0)

  await page.evaluate(() => { window.notificationTest.mode('rate'); window.notificationTest.retry() })
  await tick(200)
  await page.waitForFunction(() => window.notificationTest.state.cooldownUntil > Date.now())
  await page.evaluate(() => { window.notificationTest.mode('success'); window.notificationTest.remount() })
  await tick(200)
  await settled()
  assert.equal(await page.evaluate(() => window.notificationTest.state.cooldownUntil), 0, 'account switch clears the previous account cooldown')

  await page.evaluate(() => { window.notificationTest.mode('rate'); window.notificationTest.retry() })
  await tick(200)
  await page.waitForFunction(() => window.notificationTest.state.cooldownUntil > Date.now())
  const afterRemount = await page.evaluate(() => window.notificationTest.calls.list.length)
  await page.evaluate(() => window.notificationTestUnmount())
  await tick(60_000)
  assert.equal(await page.evaluate(() => window.notificationTest.calls.list.length), afterRemount, 'unmount cancels pending refreshes')
  assert.deepEqual(errors, [])
  console.log('PASS notification cooldown across filters/paging/retry/push/focus, cached content, latest-query recovery, unread-count reuse, burst coalescing, stale 429, mutation safety and login isolation')
} finally {
  if (browser) await browser.close()
  await server.close()
}
