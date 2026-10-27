/* global window, document */
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { log } from 'node:console'
import { chromium } from 'playwright-core'

const origin = process.env.SEP_PREVIEW_ORIGIN ?? 'http://127.0.0.1:5184'
const main = await (await fetch(origin + '/main.tsx')).text()
const react = main.match(/from "([^"]*react\.js[^"]*)"/)[1]
const dom = main.match(/from "([^"]*react-dom_client[^"]*)"/)[1]
const html = `<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">
window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
await import('/index.css');
const React=(await import('${react}')).default;
const {createRoot}=(await import('${dom}')).default;
const {FeedbackProvider,useFeedback}=await import('/components/feedback/FeedbackProvider.tsx');
const {useRuntimeFeedback}=await import('/components/feedback/use-runtime-feedback.ts');
window.callbacks=[];window.subscriptions=0;
window.electronAPI={onPiEvent:callback=>{window.callbacks.push(callback);window.subscriptions++;return ()=>{window.callbacks=window.callbacks.filter(item=>item!==callback);};}};
window.emit=(type='run_failure_notice',runId='run',owner={memberId:'member',enterpriseId:'enterprise'},code='MODEL_TIMEOUT')=>{
 const event={taskId:'task',runId,subscriptionId:'employee',type,sequence:0,occurredAt:Date.now(),data:{owner,code}};
 window.callbacks.forEach(callback=>callback(event));return event;
};
function Workspace({owner}){useRuntimeFeedback(owner,'enterprise');const [route,setRoute]=React.useState('安排工作');return React.createElement('button',{onClick:()=>setRoute('工作记录')},route);}
function App(){const feedback=useFeedback();window.feedback=feedback;const [owner,setOwner]=React.useState('member');window.setOwner=setOwner;return React.createElement(Workspace,{owner,key:owner});}
createRoot(document.getElementById('root')).render(React.createElement(FeedbackProvider,null,React.createElement(App)));
</script></body></html>`
const browser = await chromium.launch({ channel: 'msedge', headless: true })
let checks = 0
try {
  for (const width of [1200, 375]) {
    const page = await browser.newPage({ viewport: { width, height: 800 }, reducedMotion: 'reduce' })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/__runtime-feedback-test', route => route.fulfill({ contentType: 'text/html', body: html }))
    await page.goto(origin + '/__runtime-feedback-test')
    await page.waitForFunction(() => window.callbacks?.length === 1)
    await page.evaluate(() => ['auto_retry_start','auto_retry_end','session_error','arrangement_node_failed'].forEach(type=>window.emit(type)))
    assert.equal(await page.getByRole('dialog').count(), 0)
    await page.getByRole('button', { name: '安排工作', exact: true }).click()
    await page.getByRole('button', { name: '工作记录', exact: true }).waitFor()
    await page.evaluate(() => window.emit())
    const dialog = page.getByRole('dialog')
    await dialog.waitFor()
    assert.equal(await page.locator('.feedback-description').textContent(), '模型请求超时，请稍后重试')
    assert.equal(await dialog.count(), 1)
    const bounds = await dialog.boundingBox()
    assert.ok(bounds.x >= 16 && bounds.x + bounds.width <= width - 15)
    assert.equal(await dialog.evaluate(element => element.scrollWidth > element.clientWidth), false)
    await page.screenshot({ path: join(tmpdir(), `sep-runtime-feedback-${width}.png`) })
    await page.waitForTimeout(2200)
    assert.equal(await dialog.count(), 1)
    await page.getByRole('button', { name: '知道了', exact: true }).click()
    await page.evaluate(() => window.emit())
    assert.equal(await dialog.count(), 0)
    checks++

    await page.evaluate(() => { window.oldCallback=window.callbacks[0];window.feedback.clear();window.setOwner('new-member') })
    await page.waitForFunction(() => window.subscriptions === 2)
    await page.evaluate(() => {
      window.oldCallback(window.emit('run_failure_notice','late-old-run'));
      window.emit('run_failure_notice','new-run',{memberId:'new-member',enterpriseId:'enterprise'},'INTERNAL_ERROR');
    })
    await dialog.waitFor()
    assert.equal(await page.locator('.feedback-description').textContent(), '工作运行失败，请联系平台管理员')
    await page.keyboard.press('Escape')
    assert.equal(await dialog.count(), 0)
    assert.deepEqual(errors, [])
    checks++
    await page.close()
  }
  log(`Runtime feedback UI: ${checks} checks passed`)
} finally { await browser.close() }
