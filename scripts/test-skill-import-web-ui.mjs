/* global document, window */
// Real App with controlled IPC in an isolated browser; never uses the user's Electron session.
import assert from 'node:assert/strict'
import { log } from 'node:console'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

function installFixture() {
  let state = {
    revision: 0, visible: false, phase: 'idle', clientVersion: '0.3.3', protocolVersion: 1,
    sessionId: null, instanceId: null, siteLabel: null, initiatorLabel: null, scope: null,
    roots: [], pairing: null, devices: [], progress: null, error: null,
    persistenceAvailable: true, busySessionId: null,
  }
  const listeners = new Set()
  const calls = { stateReads: 0, consent: [], cancel: [] }
  const publish = patch => {
    state = { ...state, ...patch, revision: state.revision + 1 }
    for (const listener of listeners) listener(structuredClone(state))
  }
  window.skillImportFixture = {
    calls, publish,
    requestConsent: sessionId => publish({
      visible: true, phase: 'awaiting-local-consent', sessionId,
      instanceId: 'fixture-instance', siteLabel: 'SEP UI Test', initiatorLabel: '测试用户', scope: 'user',
      roots: [{ rootId: 'fixture-root', label: '测试 Skills 目录', scope: 'user', authorized: false }],
      pairing: { pairingId: 'fixture-pairing', shortCode: '123456', keyFingerprint: 'a'.repeat(64), expiresAt: new Date(Date.now() + 300_000).toISOString(), webConfirmed: true },
      progress: null, error: null,
    }),
  }
  const api = {
    platform: 'darwin', windowChrome: { height: 28, rightInset: 0 },
    listRememberedAccounts: async () => ({ accounts: [], encryptionAvailable: true }),
    getSkillImportState: async () => { calls.stateReads++; return { success: true, data: structuredClone(state) } },
    onSkillImportStateChanged: callback => { listeners.add(callback); return () => listeners.delete(callback) },
    setSkillImportVisible: async ({ visible }) => { publish({ visible }); return { success: true } },
    confirmSkillImportConsent: async input => {
      calls.consent.push(input)
      publish({ visible: false, phase: 'ready', pairing: null })
      return { success: true }
    },
    cancelSkillImport: async input => {
      calls.cancel.push(input)
      publish({ visible: false, phase: 'cancelled', pairing: null })
      return { success: true }
    },
    getUpdateState: async () => ({ success: true, state: { status: 'idle', currentVersion: '0.3.3' } }),
    login: async () => ({ success: true, data: { user: { id: 'fixture-user', name: '测试用户', email: 'fixture@example.test' }, enterprise: { id: 'fixture-enterprise', name: '测试企业' } } }),
    getSubscriptions: async () => ({ success: true, data: [] }),
    getEmployeeStatus: async () => ({ success: true, data: [] }),
    getAllTasks: async () => ({ success: true, tasks: [] }),
    listPlanningRecords: async () => ({ success: true, records: [] }),
    getEnabledModels: async () => ({ success: true, data: [] }),
    beginAttachmentImport: async ({ target }) => ({ success: true, data: { sessionId: 'fixture-attachments', target, status: 'open', attachments: [] } }),
    cancelAttachmentImport: async () => ({ success: true }),
    bindAttachmentPaste: () => () => {},
    getDefaultWorkspaceDirectory: async () => ({ success: true, path: null }),
    getUnreadNotificationCount: async () => ({ success: true, data: { count: 0 } }),
    listNotifications: async () => ({ success: true, data: { items: [], total: 0, offset: 0, limit: 20 } }),
  }
  window.electronAPI = new Proxy(api, {
    get: (target, name) => name in target ? target[name]
      : String(name).startsWith('on') ? () => () => {}
        : async () => ({ success: false, error: { message: `测试服务未启用：${String(name)}` } }),
  })
  document.documentElement.dataset.platform = api.platform
  document.documentElement.style.setProperty('--window-chrome-height', `${api.windowChrome.height}px`)
  document.documentElement.style.setProperty('--window-controls-inset', `${api.windowChrome.rightInset}px`)
}

const output = join(process.cwd(), 'output/playwright/skill-import-web')
const evidence = { passed: false, viewports: [] }
const server = await createServer({ configFile: 'vite.preview.config.ts', logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } })
let browser
try {
  await mkdir(output, { recursive: true })
  await server.listen()
  const address = server.httpServer.address()
  assert.ok(address && typeof address === 'object')
  const origin = `http://127.0.0.1:${address.port}`
  const main = await (await fetch(`${origin}/main.tsx`)).text()
  const reactUrl = main.match(/from "([^"]*react\.js[^"]*)"/)?.[1]
  const domUrl = main.match(/from "([^"]*react-dom_client[^"]*)"/)?.[1]
  assert.ok(reactUrl && domUrl, 'Vite must expose React and ReactDOM imports')
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
    import RefreshRuntime from '/@react-refresh';
    RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
    await import('/index.css');
    const React=(await import(${JSON.stringify(reactUrl)})).default;
    const {createRoot}=(await import(${JSON.stringify(domUrl)})).default;
    const {default:App}=await import('/App.tsx');
    (${installFixture.toString()})();
    createRoot(document.getElementById('root')).render(React.createElement(App));
  </script></body></html>`
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  for (const viewport of [{ width: 1200, height: 800 }, { width: 960, height: 640 }]) {
    const context = await browser.newContext({ viewport })
    try {
      const page = await context.newPage()
      const errors = []
      const externalRequests = []
      const result = { ...viewport, checks: [], screenshots: [] }
      page.on('pageerror', error => errors.push(error.message))
      await context.route('**/*', route => {
        const url = route.request().url()
        if (url === `${origin}/__skill-import-web-test`) return route.fulfill({ contentType: 'text/html', body: html })
        if (url.startsWith(`${origin}/`)) return route.continue()
        externalRequests.push(url)
        return route.abort()
      })
      const screenshot = async name => {
        const filename = `${viewport.width}x${viewport.height}-${name}.png`
        await page.screenshot({ path: join(output, filename) })
        result.screenshots.push(filename)
      }
      await page.goto(`${origin}/__skill-import-web-test`)
      await page.locator('.login-page').waitFor()
      assert.equal(await page.getByRole('button', { name: /本机 Skills 导入/ }).count(), 0)
      await page.waitForFunction(() => window.skillImportFixture.calls.stateReads > 0)
      result.checks.push('login-has-no-local-import-entry-and-initial-state-load-succeeds')
      await screenshot('login')

      await page.getByLabel('邮箱', { exact: true }).fill('fixture@example.test')
      await page.getByLabel('密码', { exact: true }).fill('fixture-password')
      await page.getByRole('button', { name: '登录', exact: true }).click()
      await page.locator('.ent-shell').waitFor()
      await page.evaluate(() => new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))))
      assert.deepEqual(await page.locator('.feedback-description').allTextContents(), [], 'Fixture must cover workspace initialization without error dialogs')
      const workspace = await page.locator('.ent-shell').elementHandle()
      assert.ok(workspace)
      await page.locator('.ent-side-user').click()
      assert.equal(await page.getByRole('menuitem', { name: /本机 Skills 导入/ }).count(), 0)
      assert.equal(await page.getByRole('menuitem', { name: '设置', exact: true }).isVisible(), true)
      assert.equal(await page.getByRole('menuitem', { name: '退出登录', exact: true }).isVisible(), true)
      await page.keyboard.press('Escape')
      result.checks.push('account-menu-has-no-local-import-entry')

      const bounds = await page.evaluate(() => {
        const right = selector => document.querySelector(selector).getBoundingClientRect().right
        return { viewport: window.innerWidth, shellRight: right('.ent-shell'), headerRight: right('.ent-top'), documentWidth: document.documentElement.scrollWidth }
      })
      assert.equal(bounds.viewport, viewport.width)
      assert.ok(Math.abs(bounds.shellRight - viewport.width) <= 1, 'Shell must reach the viewport right edge')
      assert.ok(Math.abs(bounds.headerRight - viewport.width) <= 1, 'Header must reach the viewport right edge')
      assert.ok(bounds.documentWidth <= viewport.width, 'Workspace must not overflow horizontally')
      result.layout = bounds
      result.checks.push('shell-and-header-fill-viewport-without-right-gap')

      for (const phase of ['connecting', 'scanning', 'results', 'uploading', 'uploaded']) {
        await page.evaluate(async phase => {
          window.skillImportFixture.publish({ visible: false, phase, sessionId: 'fixture-background' })
          await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)))
        }, phase)
        assert.equal(await page.locator('.ent-shell').isVisible(), true, `${phase} must preserve the workspace`)
        assert.equal(await page.locator('.skill-import-page').count(), 0)
        assert.equal(await workspace.evaluate(node => node === document.querySelector('.ent-shell') && node.isConnected), true)
      }
      result.checks.push('web-background-phases-preserve-visible-workspace-and-dom')
      assert.equal(await page.getByText(/测试服务未启用/).count(), 0)
      await screenshot('workspace')

      await page.evaluate(() => window.skillImportFixture.requestConsent('fixture-consent'))
      await page.getByRole('heading', { name: 'Skills 导入', exact: true }).waitFor()
      assert.equal(await page.locator('.ent-shell').count(), 1)
      assert.equal(await page.locator('.ent-shell').isVisible(), false)
      assert.equal(await workspace.evaluate(node => node === document.querySelector('.ent-shell') && node.isConnected), true)
      assert.equal(await page.locator('.skill-import-brand img').evaluate(image => image.complete && image.naturalWidth > 0), true)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
      await screenshot('consent')
      await page.getByRole('button', { name: '允许并开始扫描', exact: true }).click()
      await page.locator('.skill-import-page').waitFor({ state: 'detached' })
      assert.equal(await page.locator('.ent-shell').isVisible(), true)
      assert.equal(await workspace.evaluate(node => node === document.querySelector('.ent-shell') && node.isConnected), true)
      assert.deepEqual(await page.evaluate(() => window.skillImportFixture.calls.consent), [
        { pairingId: 'fixture-pairing', rememberDevice: false, scope: 'user', rootIds: ['fixture-root'] },
      ])
      result.checks.push('local-consent-is-explicit-and-returns-to-the-same-workspace-dom')

      await page.evaluate(() => window.skillImportFixture.requestConsent('fixture-cancel'))
      await page.getByRole('heading', { name: 'Skills 导入', exact: true }).waitFor()
      await page.getByRole('button', { name: '取消本次导入', exact: true }).click()
      await page.locator('.skill-import-page').waitFor({ state: 'detached' })
      assert.equal(await page.locator('.ent-shell').isVisible(), true)
      assert.equal(await workspace.evaluate(node => node === document.querySelector('.ent-shell') && node.isConnected), true)
      assert.deepEqual(await page.evaluate(() => window.skillImportFixture.calls.cancel), [{ sessionId: 'fixture-cancel' }])
      result.checks.push('cancel-consent-returns-to-the-same-workspace-dom')
      assert.deepEqual(externalRequests, [], 'UI verification must never contact external endpoints')
      assert.deepEqual(errors, [])
      result.checks.push('no-renderer-errors-or-external-network-requests')
      evidence.viewports.push(result)
      log(`PASS Web Skills import entry, background execution, consent, cancellation and layout at ${viewport.width}x${viewport.height}`)
    } finally {
      await context.close()
    }
  }
  evidence.passed = true
  await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
} finally {
  if (browser) await browser.close()
  await server.close()
}
