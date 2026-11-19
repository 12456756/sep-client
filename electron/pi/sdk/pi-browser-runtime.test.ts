import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BROWSER_MODE_TOOL, BrowserModeSession, createHostMcpRuntime } from './pi-browser-runtime'
import { createPlaywrightMcpServer } from './pi-playwright-mcp'
import type { McpRuntime } from './pi-mcp-client'
import { ToolApprovals } from '../../runtime/run-approvals'
import { SharedBrowserOwner } from './pi-browser-owner'

async function fixture() {
  let posts = 0
  let hold: { started: () => void; finish: () => void } | undefined
  const server = createServer((request, response) => {
    if (hold && request.method === 'GET') {
      const current = hold
      hold = undefined
      current.started()
      current.finish = () => response.end('<title>Resumed</title>')
      return
    }
    if (request.method === 'POST') posts++
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<title>Browser modes</title><label>Name<input id="name"></label><label>Password<input id="password" type="password"></label><form method="POST"><button>Submit</button></form><p>Public query content</p>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  // Windows can allocate a Chromium-blocked ephemeral port in the 6665-6669 range.
  while ([6000, 6665, 6666, 6667, 6668, 6669, 6697, 10080].includes((server.address() as { port: number }).port)) {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  }
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return { url: `http://127.0.0.1:${address.port}`, posts: () => posts,
    holdNextGet() {
      let started!: () => void
      const pending = new Promise<void>(resolve => { started = resolve })
      const current = { started, finish: () => undefined as void }
      hold = current
      return { pending, release: () => current.finish() }
    },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}

describe('background browser and manual window', () => {
  it('preserves task cookies, site storage, session storage and tabs across real headed/background switches without resubmitting POST', { timeout: 60_000 }, async () => {
    const http = await fixture()
    const session = new BrowserModeSession()
    try {
      const context = await session.getContext()
      const page = await context.newPage()
      await page.goto(http.url)
      const cdp = await context.newCDPSession(page)
      assert.doesNotMatch((await cdp.send('Browser.getVersion')).userAgent, /Headless/)
      await cdp.detach()
      await page.evaluate(`(async () => {
        document.cookie = 'session=fixture; path=/'
        localStorage.setItem('login', 'local-fixture')
        sessionStorage.setItem('session-login', 'session-fixture')
        await new Promise((resolve, reject) => {
          const request = indexedDB.open('login-state', 1)
          request.onupgradeneeded = () => request.result.createObjectStore('auth')
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const transaction = request.result.transaction('auth', 'readwrite')
            transaction.objectStore('auth').put('indexed-fixture', 'login')
            transaction.oncomplete = () => { request.result.close(); resolve() }
          }
        })
      })()`)
      await page.locator('button').click()
      assert.equal(http.posts(), 1)
      assert.equal(await page.evaluate(() => sessionStorage.getItem('session-login')), 'session-fixture')
      const second = await context.newPage()
      await second.goto(http.url + '/second')
      await page.locator('#name').fill('unsaved input')
      await page.evaluate('window.fixtureHeap = { retained: true }')
      assert.equal(await session.setMode('visible'), true)
      assert.equal(context.browser()?.isConnected(), true)
      const visible = await session.getContext()
      assert.equal(visible, context, 'visibility must not replace the browser context')
      assert.equal(visible.pages()[0], page)
      assert.equal(await page.locator('#name').inputValue(), 'unsaved input')
      assert.equal(await page.evaluate('window.fixtureHeap.retained'), true)
      assert.deepEqual(visible.pages().map(tab => tab.url()), [http.url + '/', http.url + '/second'])
      const target = visible.pages()[0]
      const headedCdp = await visible.newCDPSession(target)
      assert.doesNotMatch((await headedCdp.send('Browser.getVersion')).userAgent, /Headless/)
      await headedCdp.detach()
      assert.equal((await visible.cookies()).find(cookie => cookie.name === 'session')?.value, 'fixture')
      assert.deepEqual(await target.evaluate(() => [localStorage.getItem('login'), sessionStorage.getItem('session-login')]), ['local-fixture', 'session-fixture'])
      assert.equal(await target.evaluate(`new Promise((resolve, reject) => {
        const request = indexedDB.open('login-state', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const read = request.result.transaction('auth').objectStore('auth').get('login');
          read.onsuccess = () => { request.result.close(); resolve(read.result); };
          read.onerror = () => reject(read.error);
        };
      })`), 'indexed-fixture')
      await target.evaluate(() => sessionStorage.setItem('session-login', 'human-updated'))
      assert.equal(await target.evaluate(() => sessionStorage.getItem('session-login')), 'human-updated')
      assert.equal(await session.setMode('visible'), false)
      assert.equal(await session.setMode('background'), true)
      assert.equal(await (await session.getContext()).pages()[0].evaluate(() => sessionStorage.getItem('session-login')), 'human-updated')
      assert.equal(http.posts(), 1, 'mode switches must not resubmit the original form')
    } finally { await session.dispose(); await http.close() }
    await assert.rejects(session.getContext(), /closed/)
  })

  it('keeps the current browser usable when visibility is cancelled before starting', { timeout: 30_000 }, async () => {
    const session = new BrowserModeSession()
    try {
      const context = await session.getContext()
      const cancellation = new AbortController()
      cancellation.abort()
      await assert.rejects(session.setMode('visible', cancellation.signal))
      assert.equal(await session.getContext(), context)
    } finally { await session.dispose() }
  })

  for (const action of ['cancel', 'dispose'] as const) {
    it(`cleans a native visibility operation on ${action}`, { timeout: 30_000 }, async () => {
      const http = await fixture()
      let enter!: () => void
      let finish!: () => void
      let blocked = false
      const ready = new Promise<void>(resolve => { enter = resolve })
      const session = new BrowserModeSession(() => ({
        setVisible: async () => {
          if (blocked) { enter(); await new Promise<void>(resolve => { finish = resolve }) }
          return true
        }, dispose: async () => undefined,
      }))
      const cancellation = new AbortController()
      try {
        const context = await session.getContext()
        const page = await context.newPage()
        await page.goto(http.url)
        blocked = true
        const changing = session.setMode('visible', cancellation.signal)
        const rejected = assert.rejects(changing)
        await ready
        if (action === 'cancel') cancellation.abort()
        else {
          const disposing = session.dispose()
          finish()
          await disposing
        }
        if (action === 'cancel') finish()
        await rejected
        if (action === 'cancel') {
          assert.equal(await session.getContext(), context)
          assert.match(await page.title(), /Browser modes/)
        } else assert.equal(context.browser()?.isConnected(), false)
      } finally { await session.dispose(); await http.close() }
    })
  }

  it('advertises only allowlisted tools, changes mode through MCP, retains selected tab, and can reopen after browser_close', { timeout: 60_000 }, async () => {
    const http = await fixture()
    const root = await mkdtemp(join(tmpdir(), 'sep-browser-mode-'))
    let runtime: McpRuntime | undefined
    try {
      const preset = createPlaywrightMcpServer()
      let complete!: (accepted: boolean) => void
      let requested!: () => void
      const handoff = new Promise<void>(resolve => { requested = resolve })
      runtime = await createHostMcpRuntime([preset], root, true, undefined, () => {
        requested()
        return new Promise<boolean>(resolve => { complete = resolve })
      })
      const call = (name: string, input: Record<string, unknown>) => runtime!.tools.find(tool => tool.name === 'mcp__playwright__' + name)!.execute('test', input, undefined)
      assert.equal(runtime.tools.length, preset.enabledTools!.length + 1)
      assert.equal(runtime.permissions.get(BROWSER_MODE_TOOL), 'confirm-each')
      assert.equal(runtime.tools.some(tool => /browser_(evaluate|run_code|file_upload)/.test(tool.name)), false)
      assert.equal((await call('browser_set_mode', { mode: 'unknown' })).details.isError, true)
      assert.equal((await call('browser_navigate', { url: http.url })).details.isError, false)
      const input = await call('browser_type', { target: '#password', text: 'synthetic-credential' })
      assert.equal(input.details.isError, false)
      assert.equal(JSON.stringify(input).includes('synthetic-credential'), false, 'do not echo generated fill code')
      await call('browser_tabs', { action: 'new', url: http.url + '/second' })
      await call('browser_tabs', { action: 'select', index: 1 })
      let settled = false
      const pending = call('browser_set_mode', { mode: 'visible' }).then(result => { settled = true; return result })
      await handoff
      assert.equal(settled, false, 'human login must keep the task and browser alive')
      let snapshotSettled = false
      const queued = call('browser_snapshot', {}).then(result => { snapshotSettled = true; return result })
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(snapshotSettled, false, 'do not inspect or act while the user has control')
      complete(true)
      const visible = await pending
      assert.equal(visible.details.isError, false, JSON.stringify(visible))
      assert.equal((await queued).details.isError, false)
      assert.match((await call('browser_tabs', { action: 'list' })).content[0].text, /- 1: \(current\)/)
      assert.match((await call('browser_snapshot', {})).content[0].text, /Public query content/)
      assert.match((await call('browser_set_mode', { mode: 'visible', purpose: 'observe' })).content[0].text, /remains visible/)
      assert.equal((await call('browser_snapshot', {})).details.isError, false, 'observation allows automated actions to continue')
      assert.equal((await call('browser_set_mode', { mode: 'background' })).details.isError, false)
      assert.equal((await call('browser_close', {})).details.isError, false)
      assert.equal((await call('browser_navigate', { url: http.url })).details.isError, false)
      assert.equal((await call('browser_navigate', { url: 'file:///C:/Windows/win.ini' })).details.isError, true)
      await runtime.dispose()
      await runtime.dispose()
    } finally { await runtime?.dispose(); await http.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('never adds mode switching to explicitly configured hosts or disabled/planner sessions', async () => {
    const runtime = await createHostMcpRuntime([], process.cwd(), false)
    try { assert.deepEqual(runtime.tools, []) }
    finally { await runtime.dispose() }
  })

  it('retains actual pages and selected tabs across employee runtime disposal, with fresh handoff callbacks', { timeout: 60_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-shared-browser-'))
    const http = await fixture()
    const owner = new SharedBrowserOwner()
    let firstApproval = 0
    let secondApproval = 0
    let first: McpRuntime | undefined
    let second: McpRuntime | undefined
    try {
      first = await createHostMcpRuntime([createPlaywrightMcpServer()], root, true, undefined, async () => { firstApproval++; return false }, owner)
      const firstCall = (name: string, input: Record<string, unknown>) => first!.tools.find(tool => tool.name.endsWith('__' + name))!.execute('first', input, undefined)
      await firstCall('browser_navigate', { url: http.url })
      await firstCall('browser_tabs', { action: 'new', url: http.url + '/employee-shared' })
      await firstCall('browser_tabs', { action: 'select', index: 1 })
      await first.dispose()
      second = await createHostMcpRuntime([createPlaywrightMcpServer()], root, true, undefined, async () => { secondApproval++; return true }, owner)
      const secondCall = (name: string, input: Record<string, unknown>) => second!.tools.find(tool => tool.name.endsWith('__' + name))!.execute('second', input, undefined)
      await assert.rejects(firstCall('browser_snapshot', {}), /lease/i)
      assert.match((await secondCall('browser_tabs', { action: 'list' })).content[0].text, /- 1: \(current\).*employee-shared/)
      assert.match((await secondCall('browser_snapshot', {})).content[0].text, /Public query content/)
      assert.equal((await secondCall('browser_set_mode', { mode: 'visible' })).details.isError, false)
      assert.equal(firstApproval, 0)
      assert.equal(secondApproval, 1)
      await owner.revoke()
      await assert.rejects(secondCall('browser_snapshot', {}), /lease/i)
    } finally { await first?.dispose(); await second?.dispose(); await owner.dispose(); await http.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('keeps the same page when native hiding is unavailable', { timeout: 30_000 }, async () => {
    const session = new BrowserModeSession(() => ({ setVisible: async visible => visible, dispose: async () => undefined }))
    try {
      const context = await session.getContext()
      const page = await context.newPage()
      assert.equal(session.backgroundHidden, false)
      await session.setMode('visible')
      await session.setMode('background')
      assert.equal(await session.getContext(), context)
      assert.equal(context.pages()[0], page)
      assert.equal(session.backgroundHidden, false)
    } finally { await session.dispose() }
  })

  it('reports loss after the user closes the final window rather than recreating a blank page', { timeout: 30_000 }, async () => {
    const session = new BrowserModeSession()
    try {
      const context = await session.getContext()
      const page = await context.newPage()
      await page.close()
      await assert.rejects(session.getContext(), /state were lost/)
      assert.equal(session.unavailable, true)
      await session.close()
      assert.notEqual(await session.getContext(), context)
    } finally { await session.dispose() }
  })

  for (const action of ['deny', 'timeout', 'cancel', 'dispose'] as const) {
    it(`closes a pending manual handoff on ${action} without allowing more browser work`, { timeout: 30_000 }, async () => {
      const root = await mkdtemp(join(tmpdir(), 'sep-browser-handoff-'))
      const http = await fixture()
      const cancellation = new AbortController()
      let requested!: () => void
      const ready = new Promise<void>(resolve => { requested = resolve })
      let complete!: (accepted: boolean) => void
      let requestId = ''
      const approvals = new ToolApprovals({ timeoutMs: 20, onRequest: request => { requestId = request.requestId } })
      const runtime = await createHostMcpRuntime([createPlaywrightMcpServer()], root, true, undefined, () => {
        requested()
        if (action === 'timeout') return approvals.request({ taskId: 'task', runId: 'run', subscriptionId: 'sub', toolName: BROWSER_MODE_TOOL, input: {} })
        return new Promise<boolean>(resolve => { complete = resolve })
      })
      try {
        await runtime.tools.find(tool => tool.name.endsWith('__browser_navigate'))!.execute('navigate', { url: http.url }, undefined)
        const tool = runtime.tools.find(tool => tool.name === BROWSER_MODE_TOOL)!
        const pending = tool.execute('handoff', { mode: 'visible' }, cancellation.signal)
        await ready
        if (action === 'deny') complete(false)
        else if (action === 'cancel') cancellation.abort()
        else if (action === 'dispose') await runtime.dispose()
        assert.equal((await pending).details.isError, true)
        const snapshot = await runtime.tools.find(tool => tool.name.endsWith('__browser_snapshot'))!.execute('after', {}, undefined)
        assert.equal(snapshot.details.isError, true)
        if (action === 'timeout') assert.equal(approvals.respond({ requestId, approved: true }), false, 'expired completion cannot be accepted late')
        else complete(true)
      } finally { approvals.denyAll(); await runtime.dispose(); await http.close(); await rm(root, { recursive: true, force: true }) }
    })
  }
})
