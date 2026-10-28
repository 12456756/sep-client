/* global window, document */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright-core'

const browser = await chromium.launch({
  executablePath: process.env.SEP_PREVIEW_BROWSER ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(process.env.SEP_PREVIEW_URL ?? 'http://127.0.0.1:5174/?preview=workspace')
  const source = await (await page.request.get(new URL('/components/enterprise/UpdateNotice.tsx', page.url()).href)).text()
  const main = await (await page.request.get(new URL('/main.tsx', page.url()).href)).text()
  const reactPath = source.match(/from "([^"]*\/react\.js[^"]*)"/)?.[1]
  const domPath = main.match(/from "([^"]*\/react-dom_client\.js[^"]*)"/)?.[1]
  assert.ok(reactPath && domPath)
  await page.evaluate(async ({ reactPath, domPath }) => {
    const { default: React } = await import(reactPath)
    const { createRoot } = (await import(domPath)).default
    const { AppTopBar } = await import('/components/enterprise/AppTopBar.tsx')
    const { NotificationCenter } = await import('/components/enterprise/NotificationCenter.tsx')
    const { UpdateNotice } = await import('/components/enterprise/UpdateNotice.tsx')
    await import('/styles/notifications.css')
    await import('/styles/updates.css')
    window.electronAPI = {
      listNotifications: async () => ({ success: true, data: { items: [], total: 0 } }),
      getUnreadNotificationCount: async () => ({ success: true, data: { count: 0 } }),
      onNotificationUpdate: () => () => {},
      getTaskStats: async () => ({ success: true, stats: { running: 0, pending: 0, waitingApproval: 0 } }),
    }
    const e = React.createElement
    function Harness() {
      const [open, setOpen] = React.useState(false)
      const [dark, setDark] = React.useState(false)
      const [downloaded, setDownloaded] = React.useState(false)
      window.headerPanelTest = { theme: setDark, downloaded: setDownloaded }
      const update = { state: downloaded ? { status: 'downloaded', currentVersion: '0.2.0', version: '0.2.1' }
        : { status: 'idle', currentVersion: '0.2.0' }, pending: null, error: null, release: null,
        check: async () => {}, download: async () => {}, cancel: async () => {}, install: async () => {} }
      return e('div', { className: `ent-shell${dark ? ' dark' : ''}` },
        e('div', { style: { width: 64, flexShrink: 0 } }),
        e('div', { className: 'ent-shell-main' },
          e(AppTopBar, { title: '企业组织', breadcrumb: ['企业'], subtitle: '面板图层回归验证', actions:
            e('div', { className: 'ent-top-actions-group' }, e(NotificationCenter),
              e(UpdateNotice, { update, open, onOpenChange: setOpen, onOpenWorkRecords() {} })) }),
          e('div', { className: 'ent-scroll', style: { position: 'relative' } },
            // Page-local nodes intentionally overlap every sampled point.
            e('div', { style: { position: 'absolute', inset: 0, zIndex: 10000, background: 'var(--ent-canvas)' } },
              e('label', { className: 'org-tree-search', style: { position: 'absolute', right: 22, top: 18 } },
                e('input', { placeholder: '搜索部门、姓名或职位' }))))))
    }
    document.getElementById('root').remove()
    const root = document.createElement('div')
    document.body.append(root)
    createRoot(root).render(e(Harness))
  }, { reactPath, domPath })

  const assertAbovePage = async selector => {
    const panel = page.locator(selector)
    await panel.waitFor()
    const result = await panel.evaluate(el => {
      const rect = el.getBoundingClientRect()
      const hit = (x, y) => el.contains(document.elementFromPoint(x, y))
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        viewport: [window.innerWidth, window.innerHeight],
        hits: [0.15, 0.5, 0.85].flatMap(x => [0.15, 0.5, 0.85].map(y => hit(rect.left + rect.width * x, rect.top + rect.height * y))) }
    })
    assert.ok(result.left >= 0 && result.right <= result.viewport[0], `${selector} must fit viewport horizontally`)
    assert.ok(result.top >= 0 && result.bottom <= result.viewport[1], `${selector} must fit viewport vertically`)
    assert.ok(result.hits.every(Boolean), `${selector} must receive pointer input above page-local search/nodes`)
  }
  const bell = page.getByRole('button', { name: /^通知中心/ })
  const updateEntry = page.locator('.ent-update-entry')
  await bell.waitFor()
  assert.ok((await updateEntry.boundingBox()).x > (await bell.boundingBox()).x)
  await mkdir('output/playwright', { recursive: true })
  for (const [width, height] of [[1280, 800], [960, 640]]) {
    await page.setViewportSize({ width, height })
    for (const dark of [false, true]) {
      await page.evaluate(value => window.headerPanelTest.theme(value), dark)
      await bell.click()
      await assertAbovePage('.ent-notification-panel')
      const anchor = await bell.boundingBox()
      assert.ok(Math.abs((await page.locator('.ent-notification-panel').boundingBox()).y - anchor.y - anchor.height - 8) < 1)
      await page.screenshot({ path: `output/playwright/header-notifications-${width}-${dark ? 'dark' : 'light'}.png` })
      await page.keyboard.press('Escape')
      await updateEntry.click()
      await assertAbovePage('.ent-update-panel')
      await page.screenshot({ path: `output/playwright/header-update-${width}-${dark ? 'dark' : 'light'}.png` })
      await page.keyboard.press('Escape')
    }
  }
  await page.evaluate(() => window.headerPanelTest.downloaded(true))
  await updateEntry.click()
  await page.getByRole('button', { name: '重启并安装', exact: true }).click()
  await assertAbovePage('.ent-update-confirm')
  await page.getByRole('button', { name: '稍后更新', exact: true }).last().click()
  await page.getByRole('button', { name: '关闭更新面板' }).click()
  assert.deepEqual(errors, [])
  console.log('PASS: notification/update stacking, viewport positioning, header order, restart dialog, Escape/close, light/dark and 1280/960 widths')
} finally { await browser.close() }
