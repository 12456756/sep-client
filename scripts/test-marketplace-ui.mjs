/* global window, document */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const executablePath = [process.env.SEP_PREVIEW_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium',
].filter(Boolean).find(path => existsSync(path))
if (!executablePath) throw new Error('No Chromium browser found. Set SEP_PREVIEW_BROWSER.')
const html = `<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div>
<script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AppSideNav } from '/components/enterprise/AppSideNav.tsx';
import { FeedbackProvider } from '/components/feedback/FeedbackProvider.tsx';
import '/styles/enterprise.css';
window.calls = []; window.navigations = []; window.results = [];
window.electronAPI = { openMarketplace: (...args) => { window.calls.push(args); return new Promise((resolve, reject) => window.results.push({resolve, reject})); } };
window.draw = (collapsed, dark) => createRoot(document.getElementById('root')).render(
 React.createElement(FeedbackProvider, null,
 React.createElement('div', {className:'ent-shell'+(dark?' dark':''),style:{height:'100vh'}},
 React.createElement(AppSideNav, {enterpriseName:'Test Enterprise',current:'records',needsMeCount:1,canManage:false,userName:'Test User',collapsed,
 onNavigate: route => window.navigations.push(route),onOpenSettings:()=>{},onLogout:()=>{}}),
 React.createElement('main', {style:{padding:'24px'}}, 'Running task'))));
window.draw(new URLSearchParams(location.search).get('collapsed') !== 'false',new URLSearchParams(location.search).get('dark') === 'true');
</script></body></html>`
const server = await createServer({ configFile: 'vite.preview.config.ts', logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false },
  plugins: [{ name: 'marketplace-ui-fixture', configureServer(server) {
    server.middlewares.use('/__marketplace__', async (req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(await server.transformIndexHtml('/__marketplace__' + (req.url === '/' ? '' : req.url), html))
    })
  } }],
})
await server.listen()
let browser
try {
  browser = await chromium.launch({ executablePath, headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await mkdir('output/marketplace', { recursive: true })
  const label = '\u5458\u5de5\u5e02\u573a'
  const failure = '\u65e0\u6cd5\u6253\u5f00\u5458\u5de5\u5e02\u573a\uff0c\u8bf7\u91cd\u8bd5'
  const url = new URL('__marketplace__', server.resolvedUrls.local[0])
  for (const [name, collapsed, dark, width, height] of [
    ['collapsed-light', true, false, 1280, 800], ['expanded-light', false, false, 1280, 800],
    ['expanded-dark', false, true, 1280, 800], ['compact-window', true, false, 640, 560],
  ]) {
    await page.setViewportSize({ width, height })
    url.search = new URLSearchParams({ collapsed, dark }).toString()
    await page.goto(url.href)
    const button = page.getByRole('button', { name: label, exact: true })
    await button.waitFor()
    const box = await button.boundingBox()
    const account = await page.locator('.ent-icon-account').boundingBox()
    assert.ok(box.y + box.height <= account.y)
    assert.ok(box.y >= 0 && box.y + box.height <= height)
    if (!collapsed) assert.equal(await button.textContent(), label)
    await button.hover()
    await page.getByRole('tooltip').filter({ hasText: label }).waitFor()
    await page.screenshot({ path: `output/marketplace/${name}.png` })
    await button.evaluate(button => { button.click(); button.click(); button.click() })
    assert.equal(await button.isDisabled(), true)
    assert.equal(await button.getAttribute('aria-busy'), 'true')
    assert.deepEqual(await page.evaluate(() => window.calls), [[]])
    await page.evaluate(() => window.results.shift().resolve({ success: true }))
    await page.waitForFunction(() => !document.querySelector('.ent-marketplace-button').disabled)
    assert.equal(await page.getByRole('dialog').count(), 0)
    assert.deepEqual(await page.evaluate(() => window.navigations), [])
    assert.equal(await page.locator('[aria-current="page"]').getAttribute('aria-label'), '\u5de5\u4f5c\uff0c1 \u9879\u5f85\u5904\u7406')
  }
  for (const outcome of ['failure', 'reject']) {
    await page.getByRole('button', { name: label, exact: true }).click()
    await page.evaluate(outcome => {
      const pending = window.results.shift()
      if (outcome === 'failure') pending.resolve({ success: false, error: { message: 'private technical detail' } })
      else pending.reject(new Error('private technical detail'))
    }, outcome)
    await page.getByText(failure, { exact: true }).waitFor()
    assert.equal(await page.getByText('private technical detail', { exact: true }).count(), 0)
    await page.getByRole('button', { name: '\u77e5\u9053\u4e86', exact: true }).click()
  }
  await page.getByRole('button', { name: label, exact: true }).focus()
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => window.calls.length === 4)
  await page.evaluate(() => window.results.shift().resolve({ success: true }))
  assert.deepEqual(errors, [])
  console.log('Marketplace UI passed: layouts, themes, tooltip, deduplication, retry, keyboard and unchanged navigation.')
} finally {
  await browser?.close()
  await server.close()
}
