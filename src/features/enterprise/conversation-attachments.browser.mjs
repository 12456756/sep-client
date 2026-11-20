/* global window, document */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
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
})
after(async () => { await browser?.close(); await server?.close() })

async function openFixture(page, { fail = false, deferred = false, assets = false } = {}) {
  await page.addInitScript(({ fail, deferred }) => {
    const fixture = window.attachmentPreviewFixture = { calls: [], actions: [], created: [], revoked: [], fail, deferred }
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
    canvas.width = 640; canvas.height = 480
    ctx.fillStyle = 'rgba(255, 32, 16, 0.5)'; ctx.fillRect(0, 0, 320, 240)
    const outputBytes = Uint8Array.from(window.atob(canvas.toDataURL('image/png').split(',')[1]), c => c.charCodeAt(0))
    window.electronAPI = {
      revealResultFile: async file => { fixture.actions.push({ action: 'reveal', file }); return { success: true } },
      runResultFileAction: async action => { fixture.actions.push(action); return { success: true } },
      previewAttachment: async input => {
      fixture.calls.push(input)
      if (fixture.deferred) await new Promise(resolve => { fixture.resolve = resolve })
      if (fixture.fail) return { success: false, error: { message: 'Unavailable' } }
      return { success: true, data: { ...input, mediaType: 'image/png', bytes, width: 1600, height: 900 } }
    }, getTaskMedia: async taskId => ({ success: true, data: {
      capabilities: null, selectedReferenceIds: [], archived: false, jobs: [], assets: [
        { taskId, localAssetId: 'reference', source: 'reference', status: 'SAVED', mime: 'image/png', width: 1600, height: 900 },
        { taskId, localAssetId: 'output', source: 'output', status: 'SAVED', mime: 'image/png', width: 640, height: 480 },
      ],
    } }), previewMediaAsset: async ({ assetId }) => ({ success: true, data: { mime: 'image/png', bytes: assetId === 'output' ? outputBytes : bytes } }) }
  }, { fail, deferred })
  await page.route(/\/main\.tsx(?:\?.*)?$/, route => route.fulfill({ contentType: 'text/javascript', body: `${entry}
    import '/index.css';
    import '/styles/enterprise.css';
    import '/styles/arrange.css';
    import '/components/workspace/media-artifacts.css';
    import { ConversationMessagesView } from '/components/enterprise/ConversationMessages.tsx';
    import { MediaArtifactsPanel } from '/components/workspace/MediaArtifactsPanel.tsx';
    import { FileAttachmentTarget } from '/components/workspace/file-menu-actions.ts';
    import { FeedbackProvider } from '/components/feedback/FeedbackProvider.tsx';
    const base = { byteLength: 2048, sha256: 'a'.repeat(64), importSource: 'picker', extractionStatus: 'not-required', warnings: [] };
    const work = { id: 'task-images', messages: [{ id: 'message', role: 'user', content: 'Image reference', createdAt: 1, attachments: [
      { ...base, attachmentId: 'image', displayName: 'reference-with-a-long-file-name-that-must-wrap.png', mediaType: 'image/png', width: 1600, height: 900 },
      { ...base, attachmentId: 'pdf', displayName: 'brief.pdf', mediaType: 'application/pdf' },
    ] }] };
    const root = ReactDOM.createRoot(document.getElementById('root'));
    window.unmountFixture = () => root.unmount();
    root.render(React.createElement('main', { className: 'ent-shell', style: { padding: '24px', minHeight: '100vh' } },
      React.createElement(FeedbackProvider, null,
        React.createElement(FileAttachmentTarget.Provider, { value: async file => window.attachmentPreviewFixture.actions.push({ action: 'attach', file }) },
          ${assets ? `React.createElement(MediaArtifactsPanel, { taskId: work.id })` : `React.createElement(ConversationMessagesView, { work, employees: [], preparing: false, runs: [], loading: false, error: null, onReload() {} })`}))));
  ` }))
  await page.goto(base)
}

async function readClipboard(read, accepts) {
  const deadline = Date.now() + 5000
  do {
    const value = await read()
    if (accepts(value)) return value
    await delay(50)
  } while (Date.now() < deadline)
  assert.fail('Expected clipboard data was not written')
}

async function assertImageClipboard(page, { width = 1600, height = 900, alpha = 255 } = {}) {
  await page.context().grantPermissions(['clipboard-read'])
  const copiedImage = await readClipboard(() => page.evaluate(async () => {
    const item = (await window.navigator.clipboard.read()).find(item => item.types.includes('image/png'))
    if (!item) return null
    const blob = await item.getType('image/png').catch(error => {
      if (error.name === 'InvalidStateError') return null // The copy completed between read() and getType().
      throw error
    })
    if (!blob) return null
    const bitmap = await window.createImageBitmap(blob)
    const canvas = new window.OffscreenCanvas(1, 1)
    const context = canvas.getContext('2d')
    context.drawImage(bitmap, 0, 0)
    const result = { width: bitmap.width, height: bitmap.height, pixel: Array.from(context.getImageData(0, 0, 1, 1).data) }
    bitmap.close()
    return result
  }), Boolean)
  assert.deepEqual({ width: copiedImage.width, height: copiedImage.height, alpha: copiedImage.pixel[3] }, { width, height, alpha })
  if (alpha === 255) assert.deepEqual(copiedImage.pixel, [209, 231, 219, 255])
}

async function seedTextClipboard(page) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.evaluate(() => window.navigator.clipboard.writeText('before-preview-copy'))
  await page.context().clearPermissions()
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
    await mkdir('output/playwright', { recursive: true })
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

test('copy menu writes the full message and a full-size PNG to the clipboard', async t => {
  const page = await browser.newPage({ viewport: { width: 420, height: 800 } })
  t.after(() => page.close())
  await openFixture(page)
  const message = page.getByText('Image reference', { exact: true })
  const thumbnail = page.locator('.ent-message-attachment-preview')
  const menu = page.getByRole('menu')
  await message.click({ button: 'right' })
  await menu.getByRole('menuitem', { name: '复制文本' }).click()
  await menu.waitFor({ state: 'hidden' })
  await page.context().grantPermissions(['clipboard-read'])
  await readClipboard(() => page.evaluate(() => window.navigator.clipboard.readText()), text => text === 'Image reference')
  await page.context().clearPermissions()

  await page.waitForFunction(() => document.querySelector('.ent-message-attachment-preview img')?.naturalWidth > 0)
  await thumbnail.locator('img').click({ button: 'right', position: { x: 235, y: 60 } })
  const copy = menu.getByRole('menuitem', { name: '复制图片' })
  await copy.waitFor()
  const box = await menu.boundingBox()
  assert.ok(box.x >= 0 && box.x + box.width <= 420)
  await copy.click()
  await assertImageClipboard(page)
  assert.equal(await page.getByRole('dialog', { name: /图片预览/ }).count(), 0)

  await message.press('Shift+F10')
  await menu.getByRole('menuitem', { name: '复制文本' }).waitFor()
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'hidden' })
  assert.equal(await message.evaluate(element => document.activeElement === element), true)
  await thumbnail.click()
  const dialog = page.getByRole('dialog', { name: /图片预览/ })
  const largeImage = dialog.locator('img')
  const dialogMenu = dialog.getByRole('menu', { name: '文件操作' })
  await dialog.getByRole('button', { name: '放大图片', exact: true }).click()
  await largeImage.evaluate(img => img.decode())
  await largeImage.press('Shift+F10')
  await dialogMenu.waitFor()
  await page.keyboard.press('Escape')
  await dialogMenu.waitFor({ state: 'hidden' })
  assert.equal(await dialog.isVisible(), true)
  assert.equal(await largeImage.evaluate(img => img === document.activeElement), true)
  await seedTextClipboard(page)
  await largeImage.click({ button: 'right' })
  await dialogMenu.getByRole('menuitem', { name: '复制图片' }).click()
  await assertImageClipboard(page)
  await seedTextClipboard(page)
  await dialog.getByRole('button', { name: '复制图片', exact: true }).click()
  await assertImageClipboard(page)
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
})

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

test('files and images expose the same actions, including from the enlarged preview', async t => {
  const page = await browser.newPage({ viewport: { width: 420, height: 800 } })
  t.after(() => page.close())
  await openFixture(page)
  const file = page.getByText('brief.pdf', { exact: true })
  const menu = page.getByRole('menu', { name: '文件操作' })
  const actions = [['打开文件夹', 'reveal'], ['在默认应用打开', 'open'], ['添加到对话框', 'attach'], ['复制路径', 'copy-path'], ['另存为', 'save-as']]
  for (const [label] of actions) {
    await file.click({ button: 'right' })
    assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), actions.map(([name]) => name))
    await menu.getByRole('menuitem', { name: label }).click()
  }
  const thumbnail = page.locator('.ent-message-attachment-preview')
  await thumbnail.click()
  const dialog = page.getByRole('dialog', { name: /图片预览/ })
  await dialog.locator('img').evaluate(img => img.decode())
  await dialog.locator('img').press('Shift+F10')
  assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), [...actions.map(([name]) => name), '复制图片'])
  await page.keyboard.press('ArrowDown')
  assert.equal(await menu.getByRole('menuitem', { name: '在默认应用打开' }).evaluate(element => document.activeElement === element), true)
  await menu.getByRole('menuitem', { name: '添加到对话框' }).click()
  await dialog.waitFor({ state: 'hidden' })
  assert.deepEqual(await page.evaluate(() => window.attachmentPreviewFixture.actions.map(({ action, file }) => [action, file.attachmentId])),
    [...actions.map(([, action]) => [action, 'pdf']), ['attach', 'image']])
})

test('asset grids copy the selected reference or result without losing dimensions or transparency', async t => {
  const page = await browser.newPage({ viewport: { width: 420, height: 800 } })
  t.after(() => page.close())
  await openFixture(page, { assets: true })
  const reference = page.getByRole('button', { name: '放大查看参考图 1', exact: true }).locator('img')
  const output = page.getByRole('button', { name: '放大查看成果 1', exact: true })
  await reference.evaluate(img => img.decode())
  await seedTextClipboard(page)
  await reference.click({ button: 'right' })
  await page.getByRole('menuitem', { name: '复制图片', exact: true }).click()
  await assertImageClipboard(page)
  await seedTextClipboard(page)
  await output.click()
  const dialog = page.getByRole('dialog', { name: '图片大图预览' })
  await dialog.getByRole('button', { name: '复制图片', exact: true }).click()
  await assertImageClipboard(page, { width: 640, height: 480, alpha: 128 })
  assert.equal(await dialog.getByRole('button', { name: '导出图片', exact: true }).isEnabled(), true)
})

test('late preview responses do not create URLs after unmount', async t => {
  const page = await browser.newPage()
  t.after(() => page.close())
  await openFixture(page, { deferred: true })
  await page.waitForFunction(() => typeof window.attachmentPreviewFixture.resolve === 'function')
  await page.evaluate(() => { window.unmountFixture(); window.attachmentPreviewFixture.resolve() })
  assert.deepEqual(await page.evaluate(() => window.attachmentPreviewFixture.created), [])
})
