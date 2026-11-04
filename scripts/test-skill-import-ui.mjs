/* global document, window */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const endpoint = process.env.SEP_ELECTRON_DEBUG_ENDPOINT ?? 'http://127.0.0.1:9333'
const browser = await chromium.connectOverCDP(endpoint)
const output = join(process.cwd(), 'output/playwright/skill-import')
const evidence = { checks: [], screenshots: [] }
let page
let cdp
let originalVisible
try {
  await mkdir(output, { recursive: true })
  page = browser.contexts()[0].pages().find(item => /^http:\/\/(localhost|127\.0\.0\.1):/.test(item.url()))
  assert.ok(page, 'Start npm run dev:debug')
  cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.clearDeviceMetricsOverride')
  const initial = await page.evaluate(() => window.electronAPI.getSkillImportState())
  assert.equal(initial.success, true)
  assert.equal(initial.data.phase, 'idle', 'Run this check without an active import')
  originalVisible = initial.data.visible
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const route = page.locator('.login-page, .ent-shell').first()
  await route.waitFor()
  assert.equal(await page.getByRole('button', { name: /本机 Skills 导入/ }).count(), 0)
  const routeNode = await route.elementHandle()
  const dimensions = await page.evaluate(() => ({ innerWidth: window.innerWidth, outerWidth: window.outerWidth }))
  assert.equal(dimensions.innerWidth, dimensions.outerWidth, 'Native window must not retain an emulated viewport')
  evidence.checks.push('no-public-import-entry', 'native-viewport-fills-window')
  // Exercise the existing internal IPC, without adding user navigation or contacting a Web instance.
  assert.equal((await page.evaluate(() => window.electronAPI.setSkillImportVisible({ visible: true }))).success, true)
  await page.getByRole('heading', { name: 'Skills 导入', exact: true }).waitFor()
  const state = await page.evaluate(() => window.electronAPI.getSkillImportState())
  assert.equal(state.success, true)
  assert.equal(state.data.visible, true)
  assert.equal(state.data.phase, 'idle')
  assert.doesNotMatch(JSON.stringify(state.data), /privateKey|sessionGrant|uploadGrant|\/Users\/|[A-Z]:\\/)
  assert.equal(await route.isVisible(), false)
  assert.equal(await routeNode.evaluate(node => node.isConnected), true)
  evidence.checks.push('internal-real-preload-and-main-state-without-secrets', 'business-view-preserved')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  assert.equal(await page.locator('.skill-import-brand img').evaluate(image => image.complete && image.naturalWidth > 0), true)
  await page.screenshot({ path: join(output, 'native-import.png') })
  evidence.screenshots.push('native-import.png')
  await page.getByRole('button', { name: '设备授权管理', exact: true }).click()
  await page.getByRole('heading', { name: '设备授权', exact: true }).waitFor()
  await page.getByRole('button', { name: '返回工作区', exact: true }).click()
  await route.waitFor()
  assert.equal(await routeNode.evaluate(node => node.isConnected), true)
  assert.equal(await page.getByRole('button', { name: /本机 Skills 导入/ }).count(), 0)
  await page.screenshot({ path: join(output, 'native-restored.png') })
  evidence.screenshots.push('native-restored.png')
  evidence.checks.push('device-management-and-same-business-view-restored')
  assert.deepEqual(errors, [])
  await writeFile(join(output, 'evidence.json'), JSON.stringify({ ...evidence, passed: true }, null, 2) + '\n')
  console.log(JSON.stringify({ ...evidence, passed: true }))
} finally {
  try {
    if (page && originalVisible !== undefined) await page.evaluate(visible => window.electronAPI.setSkillImportVisible({ visible }), originalVisible)
  } finally {
    try { if (cdp) await cdp.send('Emulation.clearDeviceMetricsOverride') }
    finally { await browser.close() }
  }
}
