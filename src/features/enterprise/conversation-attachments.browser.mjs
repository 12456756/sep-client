/* global window, document */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

let server
let browser
let base
let entry
before(async () => {
  const executablePath = [process.env.SEP_PREVIEW_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium'].find(path => path && existsSync(path))
  assert.ok(executablePath, 'Set SEP_PREVIEW_BROWSER to an installed Chromium executable')
  server = await createServer({ configFile: resolve('vite.preview.config.ts'), server: { port: 0, strictPort: false } })
  await server.listen()
  base = server.resolvedUrls.local[0]
  const original = await (await fetch(new URL('main.tsx', base))).text()
  entry = original.slice(0, original.indexOf('import App from'))
  browser = await chromium.launch({ executablePath, headless: true })
  await mkdir('output/playwright', { recursive: true })
})
after(async () => { await browser?.close(); await server?.close() })

async function openFixture(page, { fail = false, deferred = false } = {}) {
  await page.addInitScript(({ fail, deferred }) => {
    const fixture = window.attachmentPreviewFixture = { calls: [], created: [], revoked: [], fail, deferred }
    const create = URL.createObjectURL.bind(URL)
    const revoke = URL.revokeObjectURL.bind(URL)
    URL.createObjectURL = blob => { const url = create(blob); fixture.created.push(url); return url }
    URL.revokeObjectURL = url => { fixture.revoked.push(url); revoke(url) }
    const canvas = document.createElement('canvas')
    canvas.width = 1600; canvas.height = 900
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#d1e7db'; ctx.fillRect(0, 0, 1600, 900)
    ctx.fillStyle = '#17352a'; ctx.font = '48px sans-serif'; ctx.fillText('Attachment preview', 160, 200)
    const bytes = Uint8Array.from(window.atob(canvas.toDataURL('image/png').split(',')[1]), c => c.charCodeAt(0))
    window.electronAPI = { previewAttachment: async input => {
      fixture.calls.push(input)
      if (fixture.deferred) await new Promise(resolve => { fixture.resolve = resolve })
      if (fixture.fail) return { success: false, error: { message: 'Unavailable' } }
      return { success: true, data: { ...input, mediaType: 'image/png', bytes, width: 1600, height: 900 } }
    } }
  }, { fail, deferred })
  await page.route(/\/main\.tsx(?:\?.*)?$/, route => route.fulfill({ contentType: 'text/javascript', body: `${entry}
    import '/index.css';
    import '/styles/enterprise.css';
    import '/styles/arrange.css';
    import { ConversationMessagesView } from '/components/enterprise/ConversationMessages.tsx';
    const base = { byteLength: 2048, sha256: 'a'.repeat(64), importSource: 'picker', extractionStatus: 'not-required', warnings: [] };
    const work = { id: 'task-images', messages: [{ id: 'message', role: 'user', content: 'Image reference', createdAt: 1, attachments: [
      { ...base, attachmentId: 'image', displayName: 'reference-with-a-long-file-name-that-must-wrap.png', mediaType: 'image/png', width: 1600, height: 900 },
      { ...base, attachmentId: 'pdf', displayName: 'brief.pdf', mediaType: 'application/pdf' },
    ] }] };
    const root = ReactDOM.createRoot(document.getElementById('root'));
    window.unmountFixture = () => root.unmount();
    root.render(React.createElement('main', { className: 'ent-shell', style: { padding: '24px', minHeight: '100vh' } },
      React.createElement(ConversationMessagesView, { work, employees: [], preparing: false, runs: [], loading: false, error: null, onReload() {} })));
  ` }))
  await page.goto(base)
}

for (const width of [1280, 420]) {
  test(`image attachments open, zoom and close without overflow at ${width}px`, async t => {
    const page = await browser.newPage({ viewport: { width, height: 800 } })
    t.after(() => page.close())
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await openFixture(page)
    await page.waitForFunction(() => document.querySelector('.ent-message-attachment-preview img')?.naturalWidth > 0)
    assert.equal(await page.getByText('brief.pdf', { exact: true }).count(), 1)
    assert.equal(await page.evaluate(() => window.attachmentPreviewFixture.calls.length), 1)
    assert.deepEqual(await page.evaluate(() => window.attachmentPreviewFixture.calls[0]), { taskId: 'task-images', attachmentId: 'image', sha256: 'a'.repeat(64) })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
    await page.screenshot({ path: `output/playwright/conversation-attachment-${width}.png`, fullPage: true })
    await page.locator('.ent-message-attachment-preview').click()
    const dialog = page.getByRole('dialog', { name: /图片预览/ })
    await dialog.waitFor()
    assert.equal(await dialog.locator('img').evaluate(img => img.naturalWidth), 1600)
    await page.getByRole('button', { name: '放大图片', exact: true }).click()
    assert.match(await dialog.innerText(), /100%/)
    await page.getByRole('button', { name: '缩小图片', exact: true }).click()
    assert.match(await dialog.innerText(), /75%/)
    await page.getByRole('button', { name: '适应窗口', exact: true }).click()
    await page.screenshot({ path: `output/playwright/conversation-attachment-dialog-${width}.png` })
    await page.keyboard.press('Escape')
    assert.equal(await dialog.count(), 0)
    assert.equal(await page.locator('.ent-message-attachment-preview').evaluate(element => element === document.activeElement), true)
    await page.evaluate(() => window.unmountFixture())
    assert.deepEqual(await page.evaluate(() => window.attachmentPreviewFixture.revoked), await page.evaluate(() => window.attachmentPreviewFixture.created))
    assert.deepEqual(errors, [])
  })
}

test('failed previews retain details and can be retried', async t => {
  const page = await browser.newPage()
  t.after(() => page.close())
  await openFixture(page, { fail: true })
  await page.getByText('预览不可用', { exact: true }).waitFor()
  assert.equal(await page.getByText('1600 × 900', { exact: true }).count(), 1)
  await page.evaluate(() => { window.attachmentPreviewFixture.fail = false })
  await page.getByRole('button', { name: '重新读取图片', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.ent-message-attachment-preview img')?.naturalWidth > 0)
  assert.equal(await page.evaluate(() => window.attachmentPreviewFixture.calls.length), 2)
})

test('late preview responses do not create URLs after unmount', async t => {
  const page = await browser.newPage()
  t.after(() => page.close())
  await openFixture(page, { deferred: true })
  await page.waitForFunction(() => typeof window.attachmentPreviewFixture.resolve === 'function')
  await page.evaluate(() => { window.unmountFixture(); window.attachmentPreviewFixture.resolve() })
  assert.deepEqual(await page.evaluate(() => window.attachmentPreviewFixture.created), [])
})
