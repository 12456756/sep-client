/* global window, document */
import assert from 'node:assert/strict'
import { log } from 'node:console'
import { createServer } from 'vite'
import { chromium } from 'playwright-core'

const server = await createServer({ configFile: 'vite.preview.config.ts', server: { port: 0, strictPort: false } })
let browser
try {
  await server.listen()
  const origin = server.resolvedUrls.local[0].replace(/\/$/, '')
  const main = await (await fetch(origin + '/main.tsx')).text()
  const react = main.match(/from "([^"]*react\.js[^"]*)"/)[1]
  const dom = main.match(/from "([^"]*react-dom_client[^"]*)"/)[1]
  const html = `<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
const React=(await import('${react}')).default;
const {createRoot}=(await import('${dom}')).default;
const {FeedbackProvider}=await import('/components/feedback/FeedbackProvider.tsx');
const {useSpeechInput}=await import('/features/speech/use-speech-input.ts');
const {SpeechInputActions}=await import('/components/speech/SpeechInputActions.tsx');
const {SpeechSettings}=await import('/components/speech/SpeechSettings.tsx');
window.permission='prompt';window.begins=[];window.settings=[];
window.electronAPI={
 getSpeechPermission:async()=>({success:true,data:{permission:window.permission}}),
 beginSpeechRecording:async input=>{window.begins.push(input);if(input.consent)window.permission='granted';return {success:true,data:{recordingId:input.recordingId,ready:false,permission:window.permission}};},
 cancelSpeechRecording:async()=>({success:true}),
 setSpeechEnabled:async input=>{window.settings.push(input);window.permission=input.enabled&&input.consent?'granted':'denied';return {success:true,data:{permission:window.permission}};},
};
function Input(){const [value,onChange]=React.useState('草稿');const [context,setContext]=React.useState('one');window.switchContext=()=>setContext('two');const speech=useSpeechInput({contextKey:context,value,onChange});return React.createElement('main',null,React.createElement('textarea',{...speech.inputProps,value,onChange:event=>onChange(event.target.value),'aria-label':'工作目标'}),React.createElement(SpeechInputActions,{speech}),React.createElement(SpeechSettings));}
createRoot(document.getElementById('root')).render(React.createElement(FeedbackProvider,null,React.createElement(Input)));
</script></body></html>`
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/__speech-consent-test', route => route.fulfill({ contentType: 'text/html', body: html }))
  const open = async () => {
    await page.goto(origin + '/__speech-consent-test')
    await page.getByLabel('工作目标').waitFor()
  }
  const consent = page.getByRole('dialog').filter({ hasText: '允许使用麦克风' })

  await open()
  const input = page.getByLabel('工作目标')
  await input.focus()
  await page.keyboard.down('Space')
  await consent.waitFor()
  await page.keyboard.up('Space')
  await page.waitForTimeout(100)
  assert.equal(await consent.count(), 1, 'Space release must preserve the authorization dialog')
  assert.equal(await page.evaluate(() => window.begins.length), 0)
  await consent.getByRole('button', { name: '允许', exact: true }).click()
  await page.waitForFunction(() => window.begins.length === 1)
  assert.equal(await page.evaluate(() => window.begins[0].consent), true)
  assert.equal(await input.inputValue(), '草稿')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '语音输入', exact: true }).click()
  await page.waitForFunction(() => window.begins.length === 2)
  assert.equal(await page.evaluate(() => window.begins[1].consent), undefined, 'Saved consent must be reused')

  await open()
  await page.getByRole('button', { name: '语音输入', exact: true }).click()
  await consent.waitFor()
  await consent.getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(await page.evaluate(() => window.begins.length), 0)
  await page.getByRole('button', { name: '语音输入', exact: true }).click()
  await consent.waitFor()
  await page.evaluate(() => window.switchContext())
  await consent.waitFor({ state: 'hidden' })
  assert.equal(await page.evaluate(() => window.begins.length), 0, 'Changed contexts must discard pending consent')

  await open()
  const checkbox = page.getByRole('checkbox', { name: '允许语音输入' })
  await checkbox.click()
  await consent.waitFor()
  await consent.getByRole('button', { name: '取消', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('.speech-settings input').disabled)
  assert.equal(await checkbox.isChecked(), false)
  assert.equal(await page.evaluate(() => window.settings.length), 0)
  await checkbox.click()
  await consent.getByRole('button', { name: '允许', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.speech-settings input').checked)
  assert.deepEqual(await page.evaluate(() => window.settings), [{ enabled: true, consent: true }])
  assert.deepEqual(errors, [])
  log('Speech consent UI: long Space, saved authorization, cancellation, context switching and settings passed')
} finally {
  await browser?.close()
  await server.close()
}
