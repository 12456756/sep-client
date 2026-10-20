/* global window, document, navigator, KeyboardEvent, CompositionEvent */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { describe, it, before, after } from 'node:test'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { build as bundle } from 'esbuild'
import { _electron } from 'playwright-core'
import electron from 'electron'

const root = resolve('.')
const directory = resolve('artifacts/sensevoice/client-tests')
let application, page, profile
const errors = []

async function surface(name) {
  await page.getByLabel('测试入口').selectOption(name)
}
async function recordState() {
  await page.getByTestId('snapshot').click()
  return page.locator('body').getAttribute('data-speech-phase')
}
async function recording() { await page.getByRole('button', { name: '停止录音', exact: true }).waitFor() }
async function finished() {
  await page.waitForFunction(() => !document.querySelector('.speech-status'), undefined, { timeout: 60_000 })
}

describe('production speech input in Electron (virtual microphone)', { timeout: 180_000 }, () => {
  before(async () => {
    await mkdir(directory, { recursive: true })
    profile = await mkdtemp(join(tmpdir(), 'sep-speech-client-test-'))
    await build({ configFile: false, root, envDir: false, base: './', plugins: [react()], logLevel: 'warn',
      build: { outDir: join(directory, 'renderer'), emptyOutDir: true, rollupOptions: { input: resolve('poc/sensevoice/client-test.html') } } })
    await bundle({ entryPoints: ['poc/sensevoice/client-test-main.ts'], outfile: join(directory, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'warning' })
    const env = { ...process.env, SEP_SPEECH_TEST_ROOT: root, SEP_SPEECH_TEST_DIR: directory, SEP_SPEECH_TEST_PROFILE: profile }
    delete env.ELECTRON_RUN_AS_NODE
    application = await _electron.launch({ executablePath: electron, args: [join(directory, 'main.mjs')], env, timeout: 30_000 })
    page = await application.firstWindow()
    page.setDefaultTimeout(10_000)
    page.on('pageerror', error => errors.push(error.message))
    await page.getByLabel('工作目标').waitFor()
  })
  after(async () => { await application?.close(); if (profile) await rm(profile, { recursive: true, force: true }) })

  it('first authorization persists without recording, and camera/unarmed capture stay denied', async () => {
    await page.getByRole('button', { name: '语音输入', exact: true }).click()
    await finished()
    assert.equal((await page.evaluate(() => window.electronAPI.getSpeechPermission())).data.permission, 'granted')
    const denied = await page.evaluate(async () => {
      const check = async constraints => { try { const stream = await navigator.mediaDevices.getUserMedia(constraints); stream.getTracks().forEach(track => track.stop()); return false } catch { return true } }
      return { audio: await check({ audio: true }), camera: await check({ video: true }) }
    })
    assert.deepEqual(denied, { audio: true, camera: true })
    assert.equal(await recordState(), 'idle')
  })
  it('a short Space remains undoable like ordinary text input', async () => {
    const input = page.getByLabel('工作目标')
    await input.fill('undo')
    await input.press('End')
    await page.keyboard.press('Space')
    assert.equal(await input.inputValue(), 'undo ')
    await page.keyboard.press('Control+z')
    assert.equal(await input.inputValue(), 'undo')
  })
  it('short Space, fast typing and IME Space preserve ordinary editing without recording', async () => {
    const input = page.getByLabel('工作目标')
    await input.fill('hello')
    await input.press('End')
    await page.keyboard.press('Space')
    await page.keyboard.type('world')
    assert.equal(await input.inputValue(), 'hello world')
    await input.evaluate(element => {
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      const event = new KeyboardEvent('keydown', { key: ' ', code: 'Space', isComposing: true, bubbles: true, cancelable: true })
      if (!element.dispatchEvent(event)) throw new Error('IME candidate Space was intercepted')
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    })
    assert.equal(await recordState(), 'idle')
  })
  it('button recording uses the actual worker and inserts at the caret without submitting', async () => {
    const input = page.getByLabel('工作目标')
    await input.fill('前文后文')
    await input.evaluate(element => { element.focus(); element.setSelectionRange(2, 2) })
    await page.getByRole('button', { name: '语音输入', exact: true }).click()
    await recording()
    assert.equal(await page.getByRole('button', { name: '开始工作', exact: true }).isDisabled(), true)
    await page.waitForTimeout(6200)
    await page.screenshot({ path: join(directory, 'recording-desktop.png'), fullPage: true })
    await page.getByRole('button', { name: '停止录音', exact: true }).click()
    await finished()
    const text = await input.inputValue()
    assert.ok(text.startsWith('前文') && text.endsWith('后文') && text.length > 4, text)
    assert.equal(await page.getByTestId('sent').textContent(), '0')
    await input.press('Control+z')
    assert.equal(await input.inputValue(), '前文后文')
  })
  it('holding focused Space starts recording and key release stops without adding a space', async () => {
    const input = page.getByLabel('工作目标')
    await input.fill('草稿')
    await input.press('End')
    await page.keyboard.down('Space')
    await recording()
    await page.waitForTimeout(2000)
    await page.keyboard.up('Space')
    await finished()
    const text = await input.inputValue()
    assert.ok(text.startsWith('草稿') && !text.startsWith('草稿 '), text)
    assert.equal(await page.getByTestId('sent').textContent(), '0')
  })
  it('Escape cancels immediately and switching work drops pending recording', async () => {
    await page.getByRole('button', { name: '语音输入', exact: true }).click()
    await recording()
    await page.keyboard.press('Escape')
    await finished()
    await surface('work')
    await page.getByLabel('给员工的下一句话').fill('保留工作草稿')
    await page.getByRole('button', { name: '语音输入', exact: true }).click()
    await recording()
    await page.getByTestId('switch-work').click()
    await finished()
    assert.equal(await page.getByLabel('给员工的下一句话').inputValue(), '保留工作草稿')
    assert.equal(await page.getByTestId('sent').textContent(), '0')
  })
  it('all five entry points have a shared microphone and sending remains manual', async () => {
    for (const name of ['chat', 'auto', 'manual', 'employee', 'work']) {
      await surface(name)
      assert.equal(await page.getByRole('button', { name: '语音输入', exact: true }).count(), 1, name)
    }
    await surface('two')
    await page.getByRole('button', { name: '语音输入', exact: true }).first().click()
    await recording()
    assert.equal(await page.getByRole('button', { name: '语音输入', exact: true }).isDisabled(), true)
    await page.getByRole('button', { name: '取消语音输入', exact: true }).click()
    await finished()
  })
  it('settings revoke permission, explicit reauthorization works, and existing clipboard copy still works', async () => {
    await surface('settings')
    const permission = page.getByRole('checkbox', { name: '允许语音输入' })
    await permission.uncheck()
    await page.waitForFunction(async () => (await window.electronAPI.getSpeechPermission()).data.permission === 'denied')
    await permission.check()
    await page.waitForFunction(async () => (await window.electronAPI.getSpeechPermission()).data.permission === 'granted')
    const clipboard = await application.evaluate(({ clipboard }) => clipboard.availableFormats().map(format => ({ format, bytes: [...clipboard.readBuffer(format)] })))
    try {
      await page.getByTestId('copy').click()
      assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText()), 'clipboard-regression')
    } finally {
      await application.evaluate(({ clipboard }, saved) => { clipboard.clear(); for (const item of saved) clipboard.writeBuffer(item.format, Buffer.from(item.bytes)) }, clipboard)
    }
    assert.deepEqual(errors, [])
  })
  it('keeps speech controls inside the supported desktop viewport', async () => {
    await surface('chat')
    for (const width of [1200, 960]) {
      await page.setViewportSize({ width, height: 800 })
      const bounds = await page.locator('.speech-actions').boundingBox()
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width)
      await page.screenshot({ path: join(directory, `chat-${width}.png`), fullPage: true })
    }
  })
})
