import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BROWSER_MODE_TOOL, BrowserModeSession, createHostMcpRuntime } from './pi-browser-runtime'
import { createPlaywrightMcpServer } from './pi-playwright-mcp'
import type { McpRuntime } from './pi-mcp-client'
import { ToolApprovals } from '../../runtime/run-approvals'
import { SharedBrowserOwner } from './pi-browser-owner'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAwMDAxAADAA0dAQNV85kQAAAAAElFTkSuQmCC', 'base64')

async function fixture() {
  let posts = 0
  let mediaRequests = 0
  const visits = new Map<string, number>()
  let handoffState = 'waiting'
  let hold: { started: () => void; finish: () => void } | undefined
  const server = createServer((request, response) => {
    if (request.url) visits.set(request.url, (visits.get(request.url) ?? 0) + 1)
    if (hold && request.method === 'GET') {
      const current = hold
      hold = undefined
      current.started()
      current.finish = () => response.end('<title>Resumed</title>')
      return
    }
    if (request.method === 'POST') posts++
    if (request.url === '/rate-limit-text' || request.url === '/rate-limit-http') {
      const message = request.url === '/rate-limit-text'
      response.writeHead(message ? 200 : 429, { 'content-type': 'text/html; charset=utf-8' })
      response.end(message ? '<main>由于访问频繁，无法搜索</main>' : '<main>Unavailable</main>')
      return
    }
    if (request.url === '/handoff-state') {
      response.end(handoffState)
      return
    }
    if (request.url === '/handoff' || request.url === '/handoff-configured') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<title>Handoff fixture</title><input type="password"><section></section><script>
        setInterval(async () => {
          const state = await (await fetch('/handoff-state')).text();
          if (state.startsWith('configured-')) {
            history.replaceState(null, '', state === 'configured-wrong-path' ? '/other' : '/verified');
            document.querySelector('input').hidden = true;
            document.querySelector('section').textContent = state === 'configured-url-only' ? '' : 'Verification complete';
            return;
          }
          const section = document.querySelector('section');
          section.innerHTML = state === 'waiting' ? '' : '<button>Sign out</button>';
          document.querySelector('input').hidden = state === 'complete' || state === 'complete-throttled';
          if (state === 'complete-throttled') {
            section.insertAdjacentHTML('beforeend', '<p><span>抱歉由于访问频繁导致无法搜索，</span> <span>请稍后再试！</span></p>');
          }
        }, 50);
      </script>`)
      return
    }
    if (request.url === '/media.png') {
      mediaRequests++
      response.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length })
      response.end(png)
      return
    }
    if (request.url === '/collection') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(`<title>Collection fixture</title><section id="panel" style="height:100px;overflow:auto">
        <article style="height:80px"><span>First</span><a href="/item?id=not-exposed">link</a><img src="/media.png"></article>
        <article style="display:none"><span>Hidden</span></article><article style="height:100px"><span>Second</span></article>
        </section>`)
      return
    }
    if (request.url === '/other') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<p>本文说明如何处理“抱歉由于访问频繁导致无法搜索，请稍后再试！”这类提示。</p><p hidden>抱歉由于访问频繁导致无法搜索，请稍后再试！</p>')
      return
    }
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
  return { url: `http://127.0.0.1:${address.port}`, posts: () => posts, mediaRequests: () => mediaRequests,
    visits: (path: string) => visits.get(path) ?? 0,
    setHandoffState: (state: string) => { handoffState = state },
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
  it('skips a duplicate navigation on the same background tab but allows reopening after leaving', { timeout: 40_000 }, async () => {
    const http = await fixture()
    let runtime: McpRuntime | undefined
    try {
      runtime = await createHostMcpRuntime([createPlaywrightMcpServer()], tmpdir(), true)
      const call = (name: string, input: Record<string, unknown>) => runtime!.tools.find(tool => tool.name === `mcp__playwright__${name}`)!.execute(name, input, undefined)
      const url = `${http.url}/original`
      assert.equal((await call('browser_navigate', { url })).details.isError, false)
      assert.match((await call('browser_snapshot', {})).content[0].text, /Public query content/)
      assert.match((await call('browser_navigate', { url })).content[0].text, /No new network request/)
      assert.equal(http.visits('/original'), 1)
      assert.equal((await call('browser_navigate', { url: `${http.url}/other` })).details.isError, false)
      assert.equal((await call('browser_navigate', { url })).details.isError, false)
      assert.equal(http.visits('/original'), 2)
    } finally { await runtime?.dispose(); await http.close() }
  })

  for (const path of ['/rate-limit-text', '/rate-limit-http']) {
    it(`stops queued browser operations and allows cleanup after ${path}`, { timeout: 40_000 }, async () => {
      const http = await fixture()
      let runtime: McpRuntime | undefined
      try {
        runtime = await createHostMcpRuntime([createPlaywrightMcpServer()], tmpdir(), true)
        const call = (name: string, input: Record<string, unknown>) => runtime!.tools.find(tool => tool.name === `mcp__playwright__${name}`)!.execute(name, input, undefined)
        const limited = call('browser_navigate', { url: http.url + path })
        const scroll = call('browser_scroll', { container: 'body' })
        const retry = call('browser_navigate', { url: `${http.url}/retry` })
        for (const result of await Promise.all([limited, scroll, retry])) {
          assert.equal(result.details.isError, true)
          assert.match(result.content[0].text, /站点提示访问频繁/)
        }
        assert.equal(http.visits(path), 1)
        assert.equal(http.visits('/retry'), 0)
        assert.equal((await call('browser_close', {})).details.isError, false)
        assert.equal((await call('browser_navigate', { url: `${http.url}/retry` })).details.isError, true)
        assert.equal(http.visits('/retry'), 0)
      } finally { await runtime?.dispose(); await http.close() }
    })
  }

  it('reopens persistent Edge state only within the same conversation, without exporting credentials', { timeout: 60_000 }, async () => {
    const http = await fixture()
    const root = await mkdtemp(join(tmpdir(), 'sep-persistent-edge-'))
    const state = join(root, 'task')
    const otherState = join(root, 'other-task')
    await mkdir(state)
    await mkdir(otherState)
    const first = new BrowserModeSession(undefined, state)
    const second = new BrowserModeSession(undefined, state)
    const other = new BrowserModeSession(undefined, otherState)
    try {
      first.enablePersistent()
      const context = await first.getContext()
      const page = context.pages()[0] ?? await context.newPage()
      await page.goto(http.url)
      await page.evaluate('document.cookie = "fixture=persisted; Path=/; Max-Age=3600"')
      assert.equal(await first.setMode('visible'), true)
      await first.dispose()

      second.enablePersistent()
      const reopened = await second.getContext()
      assert.equal((await reopened.cookies(http.url)).find(cookie => cookie.name === 'fixture')?.value, 'persisted')
      other.enablePersistent()
      assert.deepEqual(await (await other.getContext()).cookies(http.url), [])
    } finally { await first.dispose(); await second.dispose(); await other.dispose(); await http.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('extracts visible fields, scrolls the active tab, and saves only live page media handles', { timeout: 60_000 }, async () => {
    const http = await fixture()
    const root = await mkdtemp(join(tmpdir(), 'sep-page-tools-'))
    let runtime: McpRuntime | undefined
    try {
      await mkdir(join(root, '成果', 'task'), { recursive: true })
      runtime = await createHostMcpRuntime([createPlaywrightMcpServer()], root, true, undefined, undefined, undefined, 'task', root)
      const call = async (name: string, input: Record<string, unknown>) => await runtime!.tools.find(tool => tool.name === `mcp__playwright__${name}`)!.execute('test', input, undefined)
      assert.equal((await call('browser_set_mode', { mode: 'background', profile: 'persistent' })).details.isError, false)
      assert.equal((await call('browser_navigate', { url: http.url + '/collection' })).details.isError, false)
      const extract = { container: '#panel', item: 'article', fields: [
        { key: 'text', kind: 'text', selector: 'span' }, { key: 'url', kind: 'link', selector: 'a' },
        { key: 'ref', kind: 'media', selector: 'img' },
      ] }
      const first = await call('browser_extract', extract)
      assert.equal(first.details.isError, false, first.details.isError ? JSON.stringify({ first, tabs: await call('browser_tabs', { action: 'list' }) }) : undefined)
      const data = JSON.parse(first.content[0].text)
      assert.equal(data.rows.length, 2)
      assert.equal(data.rows[0].text, 'First')
      assert.equal(data.rows[0].url, http.url + '/item')
      assert.ok(data.rows[0].ref, first.content[0].text)
      assert.deepEqual(data.rows[1], { text: 'Second', url: null, ref: null })
      const start = JSON.parse((await call('browser_extract', { ...extract, limit: 1 })).content[0].text)
      assert.equal(start.nextOffset, 1)
      const more = JSON.parse((await call('browser_extract', { ...extract, limit: 1, offset: start.nextOffset })).content[0].text)
      assert.deepEqual(more, { rows: [data.rows[1]], truncated: false, nextOffset: null })
      const scroll = await call('browser_scroll', { container: '#panel' })
      assert.deepEqual(JSON.parse(scroll.content[0].text), { moved: true, atStart: false, atEnd: true })
      assert.equal((await call('browser_save_assets', { folder: '../bad', refs: [data.rows[0].ref] })).details.isError, true)
      assert.equal((await call('browser_save_assets', { folder: '主图', refs: [http.url + '/media.png'] })).details.isError, true)
      const firstSave = await call('browser_save_assets', { folder: '主图', refs: [data.rows[0].ref] })
      const { results: [saved] } = JSON.parse(firstSave.content[0].text)
      assert.equal(saved.status, 'saved', firstSave.content[0].text)
      assert.deepEqual(await readFile(join(root, saved.path)), png)
      const duplicate = await call('browser_save_assets', { folder: '主图', refs: [data.rows[0].ref] })
      assert.deepEqual(JSON.parse(duplicate.content[0].text).results, [{ ...saved, status: 'already_saved' }])
      assert.equal(http.mediaRequests(), 1, 'saving must not refetch a media URL')
      await call('browser_navigate', { url: http.url + '/collection?new-document' })
      const stale = await call('browser_save_assets', { folder: '主图', refs: [data.rows[0].ref] })
      assert.deepEqual(JSON.parse(stale.content[0].text).results, [{ ref: data.rows[0].ref, status: 'stale_or_unknown_reference' }])
    } finally { await runtime?.dispose(); await http.close(); await rm(root, { recursive: true, force: true }) }
  })

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
      assert.equal(runtime.tools.length, preset.enabledTools!.length + 3)
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

  it('automatically completes generic handoff after a new sign-out control appears without a login prompt', { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-browser-auto-handoff-'))
    const http = await fixture()
    let requested!: () => void
    const ready = new Promise<void>(resolve => { requested = resolve })
    const outcomes: Array<[boolean, string]> = []
    const approvals = new ToolApprovals({ timeoutMs: 10_000, onRequest: requested,
      onResolved: (_request, approved, reason) => outcomes.push([approved, reason]) })
    const runtime = await createHostMcpRuntime([createPlaywrightMcpServer()], root, true, undefined, detection =>
      approvals.request({ taskId: 'task', runId: 'run', subscriptionId: 'sub', toolName: BROWSER_MODE_TOOL,
        input: { operation: 'manual-handoff', autoDetect: true } }, detection))
    try {
      const navigate = await runtime.tools.find(tool => tool.name.endsWith('__browser_navigate'))!.execute('navigate', { url: `${http.url}/handoff` }, undefined)
      assert.equal(navigate.details.isError, false, navigate.content[0]?.text)
      const pending = runtime.tools.find(tool => tool.name === BROWSER_MODE_TOOL)!.execute('handoff', { mode: 'visible' }, undefined)
      // Surface an early tool failure rather than waiting for a prompt that will not arrive.
      await Promise.race([ready, pending.then(result => { assert.fail(result.content[0]?.text) })])
      http.setHandoffState('blocked')
      await new Promise<void>(resolve => setTimeout(resolve, 1_100))
      assert.deepEqual(outcomes, [])
      http.setHandoffState('complete')
      assert.equal((await pending).details.isError, false)
      assert.deepEqual(outcomes, [[true, 'browser_handoff_detected']])
      const approval = runtime.browserSnapshotApproval!
      const snapshotTool = runtime.tools.find(tool => tool.name.endsWith('__browser_snapshot'))!
      assert.equal(approval.claim('save', { filename: 'page.md' }), false)
      assert.equal(approval.claim('after', {}), true)
      const snapshot = await snapshotTool.execute('after', {}, undefined)
      assert.match(snapshot.content[0]?.text ?? '', /Sign out/)
      assert.equal(approval.claim('queued', {}), true)
      const navigateAway = runtime.tools.find(tool => tool.name.endsWith('__browser_navigate'))!.execute('navigate-away', {
        url: `${http.url.replace('127.0.0.1', 'localhost')}/other`,
      }, undefined)
      const stale = snapshotTool.execute('queued', {}, undefined)
      assert.equal((await navigateAway).details.isError, false)
      assert.match((await stale).content[0]?.text ?? '', /handed-off page changed/)
      assert.equal(approval.claim('outside', {}), false)
    } finally { approvals.denyAll(); await runtime.dispose(); await http.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('requires both the configured destination and the new visible success marker', { timeout: 30_000 }, async () => {
    const http = await fixture()
    let requested!: () => void
    const ready = new Promise<void>(resolve => { requested = resolve })
    const outcomes: boolean[] = []
    const approvals = new ToolApprovals({ timeoutMs: 10_000, onRequest: requested,
      onResolved: (_request, approved) => outcomes.push(approved) })
    const runtime = await createHostMcpRuntime([createPlaywrightMcpServer()], '.', true, undefined, detection =>
      approvals.request({ taskId: 'task', runId: 'run', subscriptionId: 'sub', toolName: BROWSER_MODE_TOOL,
        input: { operation: 'manual-handoff', autoDetect: true } }, detection))
    try {
      const navigate = await runtime.tools.find(tool => tool.name.endsWith('__browser_navigate'))!.execute('navigate', { url: `${http.url}/handoff-configured` }, undefined)
      assert.equal(navigate.details.isError, false, navigate.content[0]?.text)
      const pending = runtime.tools.find(tool => tool.name === BROWSER_MODE_TOOL)!.execute('handoff', {
        mode: 'visible', completion: { url: `${http.url}/verified`, text: 'Verification complete' },
      }, undefined)
      await Promise.race([ready, pending.then(result => { assert.fail(result.content[0]?.text) })])
      for (const state of ['configured-wrong-path', 'configured-url-only']) {
        http.setHandoffState(state)
        await new Promise<void>(resolve => setTimeout(resolve, 1_100))
        assert.deepEqual(outcomes, [])
      }
      http.setHandoffState('configured-complete')
      assert.equal((await pending).details.isError, false)
      assert.deepEqual(outcomes, [true])
    } finally { approvals.denyAll(); await runtime.dispose(); await http.close() }
  })

  it('stops before any retry when the full search-limit message appears during login handoff', { timeout: 30_000 }, async () => {
    const http = await fixture()
    let runtime: McpRuntime | undefined
    try {
      runtime = await createHostMcpRuntime([createPlaywrightMcpServer()], tmpdir(), true, undefined, async detection => {
        assert.ok(detection)
        http.setHandoffState('complete-throttled')
        await detection.waitForCompletion(detection.signal)
        return true
      })
      const call = (name: string, input: Record<string, unknown>) => runtime!.tools.find(tool => tool.name === `mcp__playwright__${name}`)!.execute(name, input, undefined)
      assert.equal((await call('browser_navigate', { url: `${http.url}/handoff` })).details.isError, false)
      const handoff = call('browser_set_mode', { mode: 'visible', purpose: 'handoff' })
      const retry = call('browser_navigate', { url: `${http.url}/retry` })
      for (const result of await Promise.all([handoff, retry])) {
        assert.equal(result.details.isError, true)
        assert.match(result.content[0].text, /站点提示访问频繁/)
      }
      assert.equal(http.visits('/retry'), 0)
      assert.equal((await call('browser_close', {})).details.isError, false)
    } finally { await runtime?.dispose(); await http.close() }
  })
})
