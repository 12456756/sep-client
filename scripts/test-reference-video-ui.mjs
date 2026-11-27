/* global document, window */
import assert from 'node:assert/strict'
import { log } from 'node:console'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const server = await createServer({ configFile: 'vite.preview.config.ts', logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } })
let browser
try {
  await server.listen()
  const address = server.httpServer.address()
  assert.ok(address && typeof address === 'object')
  const origin = `http://127.0.0.1:${address.port}`
  await mkdir('output/reference-video', { recursive: true })
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  for (const [name, width, height] of [['desktop', 1280, 800], ['mobile', 375, 812]]) {
    const page = await browser.newPage({ viewport: { width, height } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${origin}/testing/reference-video.html`)
    await page.getByRole('button', { name: '导入视频', exact: true }).waitFor()
    assert.match(await page.getByRole('button', { name: '导入视频', exact: true }).getAttribute('title'), /3.*90.*MP4.*MOV/)
    await page.getByRole('button', { name: '上传 商品正面展示.mp4', exact: true }).click()
    await page.getByRole('progressbar', { name: '商品正面展示.mp4 上传进度' }).waitFor()
    await page.getByText('已上传', { exact: false }).waitFor()
    const layout = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.reference-video-list li')]
      return {
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        overlap: rows.some(row => {
          const text = row.querySelector('.reference-video-name').getBoundingClientRect()
          const actions = row.querySelector('.reference-video-actions').getBoundingClientRect()
          return text.right > actions.left || text.width <= 0
        }),
      }
    })
    assert.deepEqual(layout, { overflow: false, overlap: false })
    await page.screenshot({ path: `output/reference-video/${name}.png`, fullPage: true })
    await page.getByRole('button', { name: '移除 商品正面展示.mp4', exact: true }).click()
    await page.getByText('商品正面展示.mp4', { exact: true }).waitFor({ state: 'detached' })
    assert.equal(await page.locator('.reference-video-list li').count(), 1)
    assert.deepEqual(errors, [])
    await page.close()
  }
  log('Reference video UI: desktop/mobile upload, progress, removal and layout checks passed.')
} finally { await browser?.close(); await server.close() }
