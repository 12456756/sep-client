/* global window, document, requestAnimationFrame, Storage */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { log } from 'node:console'
import { previewBrowserOptions, selectComposerModel } from './model-picker-helpers.mjs';
import { chromium } from 'playwright-core'

// Real pages and hooks with isolated IPC responses; no platform requests or task execution.
const origin = process.env.SEP_PREVIEW_ORIGIN ?? 'http://127.0.0.1:5184'
const main = await (await fetch(origin + '/main.tsx')).text()
const react = main.match(/from "([^"]*react\.js[^"]*)"/)[1]
const dom = main.match(/from "([^"]*react-dom_client[^"]*)"/)[1]
const html = readFileSync(new URL('./fixtures/auto-arrange.html', import.meta.url), 'utf8')
  .replace('__REACT__', react).replace('__DOM__', dom)
  .replace("mode:'auto'}));}", "mode:workspace.route.mode}));}")
  .replace('React.createElement(App)))', "React.createElement(new URL(window.location.href).searchParams.has('settings')?SettingsApp:App)))")
  .replace('function App(){', `
    const {SpeechSettings}=await import('/components/speech/SpeechSettings.tsx');
    window.speechBegins=0;
    window.settingsCalls=0;
    window.electronAPI.getSpeechPermission=async()=>({success:true,data:{permission:'prompt'}});
    window.electronAPI.setSpeechEnabled=async()=>{window.settingsCalls++;return {success:true,data:{permission:'granted'}};};
    window.electronAPI.beginSpeechRecording=async({recordingId,consent})=>{window.speechBegins++;return {success:true,data:{recordingId,ready:false,permission:consent?'granted':'prompt'}};};
    window.electronAPI.cancelSpeechRecording=async()=>({success:true});
    function SettingsApp(){window.feedback=useFeedback();const [visible,setVisible]=React.useState(true);window.toggleSpeechSettings=setVisible;return visible?React.createElement(SpeechSettings):null;}
    function App(){`)
const browser = await chromium.launch({ ...previewBrowserOptions(), headless: true })
let checks = 0
try {
  for (const width of [1200, 375]) {
    const page = await browser.newPage({ viewport: { width, height: 800 }, reducedMotion: 'reduce' })
    page.setDefaultTimeout(8000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/__arrange-feedback-test*', route => route.fulfill({ contentType: 'text/html', body: html }))
    const reset = async mode => {
      await page.goto(origin + '/__arrange-feedback-test')
      await page.getByRole('textbox', { name: '工作目标', exact: true }).waitFor()
      if (mode !== 'auto') await page.evaluate(mode => window.workspace.navigate({ name: 'arrange', mode }), mode)
      await page.locator('.ent-arr-mode-' + mode).waitFor()
      await page.waitForFunction(() => !document.querySelector('.ent-attachment-button')?.disabled)
    }
    const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const notice = async message => {
      const dialog = page.getByRole('dialog').filter({ hasText: message })
      await dialog.waitFor()
      assert.equal(await page.locator('.feedback-dialog').count(), 1)
      const bounds = await dialog.boundingBox()
      assert.ok(bounds.x >= 16 && bounds.x + bounds.width <= width - 15)
      assert.equal(await dialog.evaluate(element => element.scrollWidth > element.clientWidth), false)
      assert.equal(await page.locator('.ent-arr-problem, .ent-attachment-error, .speech-feedback').count(), 0)
      return dialog
    }
    const dismiss = () => page.getByRole('button', { name: '知道了', exact: true }).click()
    const start = async () => {
      await page.getByRole('textbox', { name: '工作目标', exact: true }).fill('保留我的工作目标')
      await selectComposerModel(page, 'model')
      await page.getByRole('button', { name: '开始自动编排', exact: true }).click()
    }

    await reset('auto')
    await page.evaluate(() => {
      window.electronAPI.planArrangementDraft = async () => {
        window.emit('arrangement_planning_failed', { message: '自动编排模型响应异常，请联系平台管理员' })
        window.emit('arrangement_planning_failed', { message: '自动编排模型响应异常，请联系平台管理员' })
        return new Promise(resolve => { window.replyFailure = () => resolve({ success: false, error: { message: '自动编排模型响应异常，请联系平台管理员' } }) })
      }
    })
    await start()
    await notice('自动编排模型响应异常，请联系平台管理员')
    await dismiss()
    await page.evaluate(() => window.replyFailure())
    await frames()
    assert.equal(await page.locator('.feedback-dialog').count(), 0)
    checks++

    await reset('auto')
    await page.evaluate(() => {
      window.plans = 0
      const create = window.electronAPI.createArrangementDraft
      window.electronAPI.createArrangementDraft = async input => new Promise(resolve => { window.replyCreate = async () => resolve(await create(input)) })
      window.electronAPI.planArrangementDraft = async () => { window.plans++; return { success: false } }
    })
    await start()
    await page.evaluate(() => { window.feedback.clear(); window.workspace.navigate({ name: 'arrange', mode: 'chat' }) })
    await page.locator('.ent-arr-mode-chat').waitFor()
    await page.evaluate(() => window.replyCreate())
    await frames()
    assert.equal(await page.evaluate(() => window.plans), 0)
    assert.equal(await page.locator('.feedback-dialog').count(), 0)
    checks++

    await reset('chat')
    await page.evaluate(() => {
      window.electronAPI.preflightArrangementDraft = async () => ({ success: false, error: { message: '网络连接失败，请检查网络' } })
    })
    await page.getByRole('textbox', { name: '工作目标', exact: true }).fill('失败后保留这段输入')
    await page.getByRole('button', { name: '开始工作', exact: true }).click()
    await notice('网络连接失败，请检查网络')
    await page.screenshot({ path: join(tmpdir(), `sep-arrange-feedback-light-${width}.png`) })
    await page.waitForTimeout(2200)
    assert.equal(await page.locator('.feedback-dialog').count(), 1)
    assert.equal(await page.evaluate(() => window.counts.start), 0)
    await dismiss()
    assert.equal(await page.getByRole('textbox', { name: '工作目标', exact: true }).inputValue(), '失败后保留这段输入')
    checks++

    await reset('chat')
    await page.evaluate(() => { window.electronAPI.selectAttachments = async () => ({ success: false, error: { message: '单个附件不能超过 20 MiB。' } }); window.electronAPI.listAttachments = async () => ({ success: true, data: [] }) })
    await page.getByRole('button', { name: '添加附件', exact: true }).click()
    await notice('单个附件不能超过 20 MiB。')
    await dismiss()
    assert.equal(await page.locator('.feedback-dialog').count(), 0)
    await page.evaluate(() => { window.electronAPI.selectDirectory = async () => ({ success: false }) })
    await page.locator('.ent-rs-directory').click()
    await frames()
    assert.equal(await page.locator('.feedback-dialog').count(), 0)
    checks++

    await reset('chat')
    await page.getByRole('button', { name: '语音输入', exact: true }).click()
    await notice('允许使用麦克风进行语音输入？')
    assert.equal(await page.getByRole('button', { name: '取消', exact: true }).evaluate(element => element === document.activeElement), true)
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await frames()
    assert.equal(await page.evaluate(() => window.speechBegins), 0)
    assert.equal(await page.locator('.feedback-dialog').count(), 0)
    await page.getByRole('button', { name: '语音输入', exact: true }).click()
    await notice('允许使用麦克风进行语音输入？')
    await page.evaluate(() => window.workspace.navigate({ name: 'arrange', mode: 'manual' }))
    await page.locator('.ent-arr-mode-manual').waitFor()
    await frames()
    assert.equal(await page.evaluate(() => window.speechBegins), 0)
    assert.equal(await page.locator('.feedback-dialog').count(), 0)
    checks++

    await reset('manual')
    await page.getByRole('button', { name: '添加员工', exact: true }).click()
    await page.locator('.ent-mn-pick').getByRole('button', { name: '调研员' }).click()
    await page.getByRole('textbox', { name: '工作目标', exact: true }).fill('手动安排的目标')
    await page.getByRole('button', { name: '开始', exact: true }).click()
    await notice('有工作步骤还没有写工作内容')
    assert.equal(await page.evaluate(() => window.counts.create), 0)
    await dismiss()
    await page.getByRole('textbox', { name: '工作', exact: true }).fill('整理工作内容')
    await page.evaluate(() => { window.savedSetItem = Storage.prototype.setItem; Storage.prototype.setItem = () => { throw new Error('private path /secret') } })
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await notice('常用工作未能保存到本机，请联系平台管理员')
    await page.evaluate(() => document.documentElement.classList.add('dark'))
    await frames()
    const copy = await page.locator('.feedback-description').evaluate(element => ({
      width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height,
      color: window.getComputedStyle(element).color, parentHeight: element.parentElement.clientHeight,
    }))
    assert.ok(copy.width > 0 && copy.height > 0 && copy.parentHeight > 0, JSON.stringify(copy))
    assert.equal(copy.color, 'rgb(241, 241, 241)')
    await page.screenshot({ path: join(tmpdir(), `sep-arrange-feedback-dark-${width}.png`) })
    await dismiss()
    assert.equal(await page.getByRole('button', { name: '已保存', exact: true }).count(), 0)
    assert.equal(await page.getByRole('textbox', { name: '工作目标', exact: true }).inputValue(), '手动安排的目标')
    await page.evaluate(() => { Storage.prototype.setItem = window.savedSetItem })
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await notice('常用工作保存成功')
    await page.waitForTimeout(2300)
    assert.equal(await page.locator('.feedback-dialog').count(), 0)
    checks++
    await page.goto(origin + '/__arrange-feedback-test?settings')
    const enableSpeech = page.getByRole('checkbox', { name: '允许语音输入', exact: true })
    await enableSpeech.click()
    await notice('允许使用麦克风进行语音输入？')
    await page.getByRole('button', { name: '取消', exact: true }).click()
    assert.equal(await page.evaluate(() => window.settingsCalls), 0)
    await enableSpeech.click()
    await notice('允许使用麦克风进行语音输入？')
    await page.evaluate(() => window.toggleSpeechSettings(false))
    await frames()
    assert.equal(await page.locator('.feedback-dialog').count(), 0)
    assert.equal(await page.evaluate(() => window.settingsCalls), 0)
    await page.evaluate(() => window.toggleSpeechSettings(true))
    await enableSpeech.click()
    await notice('允许使用麦克风进行语音输入？')
    await page.getByRole('button', { name: '允许', exact: true }).click()
    await page.waitForFunction(() => window.settingsCalls === 1)
    assert.equal(await enableSpeech.isChecked(), true)
    assert.equal(await page.locator('.feedback-dialog').count(), 0)
    checks++
    assert.deepEqual(errors, [])
    log(`PASS arrangement feedback at ${width}px`)
    await page.close()
  }
  log(`PASS ${checks} arrangement feedback scenarios`)
} finally { await browser.close() }
