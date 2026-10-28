/* global window */
// Real hooks/components with controlled IPC and browser time; no account or server changes.
import assert from 'node:assert/strict'
import { log } from 'node:console'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const server = await createServer({ configFile: 'vite.preview.config.ts', logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } })
let browser
try {
  await server.listen()
  const address = server.httpServer.address()
  assert.ok(address && typeof address === 'object')
  const origin = 'http://127.0.0.1:' + address.port
  const main = await (await fetch(origin + '/main.tsx')).text()
  const reactUrl = main.match(/from "([^"]*react\.js[^"]*)"/)[1]
  const domUrl = main.match(/from "([^"]*react-dom_client[^"]*)"/)[1]
  const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">' +
    "import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;" +
    "await import('/index.css');await import('/styles/notifications.css');const React=(await import('" + reactUrl + "')).default;const {createRoot}=(await import('" + domUrl + "')).default;" +
    "const {NotificationCenter}=await import('/components/enterprise/NotificationCenter.tsx');const {SkillsPage}=await import('/pages/enterprise/SkillsPage.tsx');const {useSkillLibrary}=await import('/features/enterprise/use-skill-library.ts');" +
    "const mode=new URL(location.href).searchParams.get('case');window.loadingCalls={page:0,count:0,skills:0};const listeners=new Set();window.pushLoadingUpdate=event=>{for(const listener of listeners)listener(event)};" +
    "const limited={success:false,error:{code:'RATE_LIMITED',statusCode:429,message:'limited',retryAfterMs:60000}};const row={id:'notification-1',type:'INFO',title:'恢复后的通知',message:'完整内容',read:false,category:'SYSTEM',severity:'INFO',createdAt:'2026-10-27T00:00:00Z'};" +
    "window.electronAPI={onNotificationUpdate:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},listNotifications:async()=>{const call=++window.loadingCalls.page;if(mode==='auth')return {success:false,error:{code:'AUTH_REQUIRED',statusCode:401,message:'expired'}};if(call===1)return mode==='transient'?{success:false,error:{code:'SERVICE_UNAVAILABLE',statusCode:503,message:'unavailable'}}:limited;return {success:true,data:{items:[row],total:1}}}," +
    "getUnreadNotificationCount:async()=>{window.loadingCalls.count++;return {success:true,data:{count:1}}},listSkillLibrary:async()=>{if(++window.loadingCalls.skills===1)return await new Promise(resolve=>setTimeout(()=>resolve({success:false,error:{code:'NETWORK_ERROR',statusCode:0,message:'连接超时'}}),15000));return {success:true,data:[{capability:{id:'skill',name:'恢复后的技能',description:'已加载',type:'SKILL'},versions:[],usableVersionIds:[],bindings:[],localVersions:[]}]}}};" +
    "function SkillFixture(){const library=useSkillLibrary('enterprise:member');return React.createElement(SkillsPage,{workspace:{...library,employees:[],navigate:()=>{}}})}const root=createRoot(document.getElementById('root'));window.unmountLoading=()=>root.unmount();root.render(React.createElement('div',{className:'ent-shell'},React.createElement(mode==='skills'?SkillFixture:NotificationCenter)));" +
    '</script></body></html>'
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  for (const mode of ['limited', 'transient', 'auth', 'cleanup', 'skills']) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.clock.install()
    await page.route('**/__content-loading-test?*', route => route.fulfill({ contentType: 'text/html', body: html }))
    await page.goto(origin + '/__content-loading-test?case=' + mode)
    if (mode === 'skills') {
      await page.getByText('正在加载技能…', { exact: true }).waitFor()
      await page.clock.runFor(15_100)
      await page.getByRole('alert').filter({ hasText: '暂时无法连接技能服务' }).waitFor()
      await page.getByRole('button', { name: '重试', exact: true }).click()
      await page.getByRole('heading', { name: '恢复后的技能' }).waitFor()
      assert.equal(await page.evaluate(() => window.loadingCalls.skills), 2)
    } else {
      await page.getByRole('button', { name: /通知中心/ }).click()
      const expected = mode === 'auth' ? '登录状态已过期，请重新登录。' : mode === 'transient' ? '暂时无法获取通知，请稍后重试。' : '通知请求较多，请稍后重试。'
      await page.getByText(expected, { exact: true }).waitFor()
      assert.equal(await page.evaluate(() => window.loadingCalls.page), 1)
      if (mode === 'limited') {
        await page.evaluate(() => { for (let i = 0; i < 5; i++) window.pushLoadingUpdate({ type: 'resync' }) })
        await page.clock.runFor(59_000)
        assert.equal(await page.evaluate(() => window.loadingCalls.page), 1)
        await page.clock.runFor(1500)
      } else if (mode === 'transient') {
        await page.clock.runFor(3100)
      } else {
        if (mode === 'cleanup') await page.evaluate(() => window.unmountLoading())
        await page.clock.runFor(120_000)
        assert.equal(await page.evaluate(() => window.loadingCalls.page), 1)
      }
      if (mode === 'limited' || mode === 'transient') {
        await page.getByRole('heading', { name: '恢复后的通知' }).waitFor()
        assert.equal(await page.evaluate(() => window.loadingCalls.page), 2)
      }
    }
    assert.deepEqual(errors, [])
    log('PASS content loading: ' + mode)
    await page.close()
  }
} finally {
  await browser?.close()
  await server.close()
}
