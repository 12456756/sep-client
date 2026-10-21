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
    await input.press('Enter')
    assert.equal(await page.getByTestId('sent').textContent(), '0')
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
  it('Enter sends and Shift+Enter edits a newline without sending or interfering with IME', async () => {
    for (const name of ['chat', 'auto', 'employee', 'work']) {
      await surface(name)
      const input = name === 'employee' ? page.locator('textarea') : page.getByLabel(name === 'work' ? '给员工的下一句话' : '工作目标')
      const before = Number(await page.getByTestId('sent').textContent())
      await input.fill('')
      await input.press('Enter')
      assert.equal(Number(await page.getByTestId('sent').textContent()), before, `${name}: empty input`)
      await input.fill('第一行')
      await input.press('End')
      await input.press('Shift+Enter')
      await input.press('x')
      assert.equal(await input.inputValue(), '第一行\nx', `${name}: newline`)
      for (const extra of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }]) {
        await input.evaluate((element, init) => {
          element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, ...init }))
        }, extra)
        assert.equal(Number(await page.getByTestId('sent').textContent()), before, `${name}: ${JSON.stringify(extra)}`)
      }
      await input.press('Enter')
      await page.waitForFunction(expected => Number(document.querySelector('[data-testid="sent"]').textContent) === expected, before + 1)
      assert.equal(Number(await page.getByTestId('sent').textContent()), before + 1, `${name}: send`)
    }
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
  it('system revocation blocks recording, retains app consent, and opens settings only on explicit action', async () => {
    await surface('chat')
    const input = page.getByLabel('工作目标')
    await input.fill('保留草稿')
    await application.evaluate(() => { globalThis.speechSystemTest.status = 'denied' })
    await page.getByRole('button', { name: '语音输入', exact: true }).click()
    await finished()
    assert.match(await page.getByRole('alert').textContent(), /Windows.*设置/)
    assert.equal(await input.inputValue(), '保留草稿')
    assert.equal((await page.evaluate(() => window.electronAPI.getSpeechPermission())).data.permission, 'granted')
    assert.deepEqual(await application.evaluate(() => globalThis.speechSystemTest.opened), [])
    await surface('settings')
    const permission = page.getByRole('checkbox', { name: '允许语音输入' })
    await permission.uncheck()
    await page.waitForFunction(async () => (await window.electronAPI.getSpeechPermission()).data.permission === 'denied')
    await permission.click()
    await page.getByRole('alert').filter({ hasText: 'Windows' }).waitFor()
    assert.equal(await permission.isChecked(), false)
    await page.screenshot({ path: join(directory, 'system-permission-settings.png'), fullPage: true })
    await page.getByRole('button', { name: '打开系统麦克风设置', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.speech-settings button').disabled)
    assert.deepEqual(await application.evaluate(() => globalThis.speechSystemTest.opened), ['ms-settings:privacy-microphone'])
    assert.equal(await application.evaluate(() => globalThis.speechSystemTest.requests), 0)
    await application.evaluate(() => { globalThis.speechSystemTest.status = 'granted' })
    await permission.check()
    await page.waitForFunction(async () => (await window.electronAPI.getSpeechPermission()).data.permission === 'granted')
    await surface('chat')
    await page.getByRole('button', { name: '语音输入', exact: true }).click()
    await recording()
    await page.getByRole('button', { name: '取消语音输入', exact: true }).click()
    await finished()
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

describe('macOS authorization policy in Electron (simulated OS APIs)', { timeout: 60_000 }, () => {
  let macApplication, macPage, macProfile
  before(async () => {
    macProfile = await mkdtemp(join(tmpdir(), 'sep-speech-mac-policy-test-'))
    const env = { ...process.env, SEP_SPEECH_TEST_ROOT: root, SEP_SPEECH_TEST_DIR: directory,
      SEP_SPEECH_TEST_PROFILE: macProfile, SEP_SPEECH_TEST_PLATFORM: 'darwin' }
    delete env.ELECTRON_RUN_AS_NODE
    macApplication = await _electron.launch({ executablePath: electron, args: [join(directory, 'main.mjs')], env })
    macPage = await macApplication.firstWindow()
    await macPage.getByLabel('工作目标').waitFor()
    await macApplication.evaluate(() => { globalThis.speechSystemTest.status = 'not-determined' })
  })
  after(async () => { await macApplication?.close(); if (macProfile) await rm(macProfile, { recursive: true, force: true }) })
  it('uses system consent once, requires a new gesture, and rejects revoked access', async () => {
    await macPage.getByRole('button', { name: '语音输入', exact: true }).click()
    await macPage.getByText('麦克风已授权。', { exact: true }).waitFor()
    assert.equal(await macPage.getByRole('button', { name: '停止录音', exact: true }).count(), 0)
    assert.deepEqual(await macApplication.evaluate(() => ({ requests: globalThis.speechSystemTest.requests,
      confirms: globalThis.speechSystemTest.confirms })), { requests: 1, confirms: 0 })
    await macPage.getByRole('button', { name: '语音输入', exact: true }).click()
    await macPage.getByRole('button', { name: '停止录音', exact: true }).waitFor()
    await macPage.getByRole('button', { name: '取消语音输入', exact: true }).click()
    await macApplication.evaluate(() => { globalThis.speechSystemTest.status = 'denied' })
    await macPage.getByRole('button', { name: '语音输入', exact: true }).click()
    await macPage.getByRole('alert').filter({ hasText: 'macOS' }).waitFor()
    assert.equal(await macApplication.evaluate(() => globalThis.speechSystemTest.requests), 1)
    const response = await macPage.evaluate(() => window.electronAPI.openSpeechSystemSettings())
    assert.equal(response.success, true)
    assert.deepEqual(await macApplication.evaluate(() => globalThis.speechSystemTest.opened),
      ['x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'])
  })
})
