/* global window, document, localStorage */
// Real application shell with controlled IPC; no account, server or model writes.
import assert from 'node:assert/strict'
import { log } from 'node:console'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const server = await createServer({ configFile: 'vite.preview.config.ts', logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } })
let browser
try {
  await server.listen()
  const origin = server.resolvedUrls.local[0]
  const main = await (await fetch(new URL('main.tsx', origin))).text()
  const entry = main.slice(0, main.indexOf('import App from'))
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  await mkdir('output/playwright', { recursive: true })
  for (const [platform, width, height, dark] of [['darwin', 1200, 800, false], ['darwin', 960, 640, false], ['darwin', 1200, 800, true], ['win32', 960, 640, false]]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(({ dark }) => {
      if (dark) localStorage.setItem('sep.theme', 'dark')
      const ok = data => ({ success: true, data })
      const api = {
        setWindowTheme: async () => ok(null),
        getAllTasks: async () => ({ success: true, tasks: [] }),
        getClientProfile: async () => ({ success: false }),
        listNotifications: async () => ok({ items: [], total: 0 }),
        getUnreadNotificationCount: async () => ok({ count: 0 }),
        beginAttachmentImport: async ({ target }) => ok({ sessionId: 'fixture-attachment', status: 'open', attachments: [], target }),
        bindAttachmentPaste: () => () => {},
      }
      window.electronAPI = new Proxy(api, { get: (target, name) => name in target ? target[name] : String(name).startsWith('on') ? () => () => {} : async () => ({ success: false, error: { message: '测试服务未启用' } }) })
    }, { platform, dark })
    await page.route(/\/main\.tsx(?:\?.*)?$/, route => route.fulfill({ contentType: 'text/javascript', body: `${entry}
      import '/index.css';
      import { FeedbackProvider } from '/components/feedback/FeedbackProvider.tsx';
      import { ClientAppPage } from '/pages/ClientAppPage.tsx';
      document.documentElement.dataset.platform = ${JSON.stringify(platform)};
      document.documentElement.style.setProperty('--window-controls-inset', '${platform === 'win32' ? 144 : 0}px');
      const update = { state: { status: 'idle', currentVersion: '0.2.2' }, pending: null, error: null, release: null };
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null,
        React.createElement('div', { className: 'electron-window-chrome electron-drag-region', 'aria-hidden': true }),
        React.createElement(FeedbackProvider, null,
          React.createElement(ClientAppPage, { userId: 'fixture-user', userName: '测试用户', enterpriseId: 'fixture-enterprise', enterpriseName: '测试企业名称很长时保持单行省略', instances: [], employeeStatuses: [], onLogout: () => {}, update }))));
    ` }))
    await page.goto(origin)
    await page.waitForFunction(() => document.querySelector('.ent-icon-nav'), undefined, { timeout: 10000 }).catch(error => { throw new Error(`${error.message}; renderer errors: ${errors.join('; ')}`) })
    const nav = page.getByRole('navigation', { name: '主导航' })
    await nav.getByRole('button', { name: '工作', exact: true }).click()
    const assertLayout = async expanded => {
      const metrics = await page.evaluate(() => {
        const rect = selector => {
          const r = document.querySelector(selector).getBoundingClientRect()
          return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }
        }
        const isClickable = button => {
          const r = button.getBoundingClientRect()
          const target = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
          return button.contains(target) && r.right <= window.innerWidth
        }
        const actions = [...document.querySelectorAll('.ent-top-actions-group button')].map(isClickable)
        const nav = rect('.ent-icon-nav')
        const navButtonsFit = [...document.querySelectorAll('.ent-icon-nav button:not([role="menuitem"])')].every(button => button.getBoundingClientRect().right <= nav.right)
        return { nav, navButtonsFit, main: rect('.ent-shell-main'), header: rect('.ent-top'), chrome: rect('.electron-window-chrome'), brand: rect('.ent-icon-brand-button'), firstNav: rect('.ent-icon-nav-item'), toggle: rect('.ent-top-sidebar-toggle'), toggleClickable: isClickable(document.querySelector('.ent-top-sidebar-toggle')), actions, overflow: document.documentElement.scrollWidth > window.innerWidth }
      })
      assert.equal(metrics.nav.width, expanded ? 200 : 80)
      assert.equal(metrics.main.x, metrics.nav.right)
      assert.equal(metrics.nav.x, 0)
      assert.equal(metrics.navButtonsFit, true, 'long labels must stay within the sidebar')
      assert.equal(metrics.header.y, platform === 'darwin' ? 0 : 44)
      if (platform === 'darwin') {
        assert.equal(metrics.chrome.width, 80)
        assert.ok(metrics.brand.y >= 44)
      }
      assert.ok(metrics.firstNav.y - metrics.brand.bottom >= 32, 'navigation must leave a clear gap below the company icon')
      assert.ok(metrics.firstNav.y < height / 3, 'navigation must sit near the top')
      assert.ok(metrics.toggle.x >= metrics.header.x && metrics.toggle.right <= metrics.header.x + 64, 'toggle must sit at the left of the toolbar')
      assert.ok(metrics.toggle.y >= metrics.header.y && metrics.toggle.bottom <= metrics.header.bottom)
      assert.equal(metrics.toggleClickable, true, 'the toolbar toggle must not be blocked by the drag overlay')
      assert.ok(metrics.actions.every(Boolean), 'toolbar actions must stay inside the viewport and outside the drag overlay')
      assert.equal(metrics.overflow, false)
    }
    await assertLayout(false)
    await page.getByRole('button', { name: '展开侧栏', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: '收起侧栏', exact: true }).getAttribute('aria-expanded'), 'true')
    for (const label of ['首页', '工作', '硅基员工', '员工技能', '知识库', '算力中心']) assert.equal(await nav.locator('.ent-icon-label').getByText(label, { exact: true }).isVisible(), true)
    await assertLayout(true)
    assert.equal(await page.locator('.ent-top-sidebar-toggle .lucide-panel-left').count(), 1)
    assert.equal(await nav.getByRole('button', { name: /侧栏/ }).count(), 0)
    await nav.getByRole('img', { name: '测试企业名称很长时保持单行省略', exact: true }).hover()
    await page.getByRole('tooltip', { name: '测试企业名称很长时保持单行省略', exact: true }).waitFor()
    assert.equal(await page.getByRole('menuitem', { name: '企业组织', exact: true }).count(), 0)
    await page.mouse.move(width - 10, height / 2)
    await page.screenshot({ path: `output/playwright/shell-expanded-${platform}-${width}-${dark ? 'dark' : 'light'}.png` })
    await page.reload()
    await page.getByRole('button', { name: '收起侧栏', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => localStorage.getItem('sep.sidebar.collapsed')), 'false')
    await nav.getByRole('button', { name: '工作', exact: true }).click()
    await assertLayout(true)
    await page.getByRole('button', { name: /客户端更新，打开更新面板/ }).click()
    const updatePanel = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '客户端更新', exact: true }) })
    await updatePanel.waitFor()
    assert.ok((await updatePanel.boundingBox()).y >= (await page.locator('.ent-top').boundingBox()).height)
    await page.getByRole('button', { name: '关闭更新面板', exact: true }).click()
    await page.getByRole('button', { name: '收起侧栏', exact: true }).focus()
    await page.keyboard.press('Enter')
    await page.getByRole('button', { name: '展开侧栏', exact: true }).waitFor()
    await assertLayout(false)
    const work = nav.getByRole('button', { name: '工作', exact: true })
    await work.hover()
    await page.getByRole('tooltip', { name: '工作', exact: true }).waitFor()
    await page.mouse.move(width - 10, height / 2)
    await page.screenshot({ path: `output/playwright/shell-collapsed-${platform}-${width}-${dark ? 'dark' : 'light'}.png` })
    await nav.locator('.ent-icon-account-button').click()
    await page.getByRole('menuitem', { name: '设置', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    assert.deepEqual(errors, [])
    log(`PASS shell ${platform} ${width}x${height} ${dark ? 'dark' : 'light'}: labels, persistence, keyboard toggle, tooltip, account menu, toolbar hit targets, update panel and overflow`)
    await page.close()
  }
} finally {
  await browser?.close()
  await server.close()
}
