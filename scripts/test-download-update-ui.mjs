/* global window */
// Real renderer, isolated browser and controlled IPC; no publishing or OS installation side effects.
import assert from 'node:assert/strict'
import { log } from 'node:console'
import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const { version: currentVersion } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const currentNotes = await readFile(new URL('../release-notes/' + currentVersion + '.md', import.meta.url), 'utf8')
const firstHeading = currentNotes.match(/^### (.+)$/m)[1]
const screenshots = new URL('../artifacts/update-notes/', import.meta.url)
await mkdir(screenshots, { recursive: true })

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
    "await import('/index.css');const React=(await import('" + reactUrl + "')).default;const {createRoot}=(await import('" + domUrl + "')).default;const {default:App}=await import('/App.tsx');" +
    "const currentVersion=" + JSON.stringify(currentVersion) + ";window.updateCalls={check:0,download:0,install:0};let state={status:'not-available',currentVersion,checkedAt:new Date().toISOString()};const listeners=new Set();const publish=next=>{state=next;for(const listener of listeners)listener(state)};" +
    "const api={platform:'darwin',windowChrome:{height:28,rightInset:0},listRememberedAccounts:async()=>({accounts:[],encryptionAvailable:true})," +
    "getUpdateState:async()=>({success:true,state}),onUpdateStateChanged:callback=>{listeners.add(callback);return()=>listeners.delete(callback)}," +
    "checkForUpdate:async()=>{window.updateCalls.check++;const available={status:'available',currentVersion,version:'0.99.0',releaseDate:null,releaseNotes:['改进更新体验'],downloadMode:'external'};publish({status:'checking',currentVersion});setTimeout(()=>publish(available),0);return {success:true}}," +
    "downloadUpdate:async()=>{window.updateCalls.download++;publish({...state,downloadOpened:true});return {success:true}},installUpdate:async()=>{window.updateCalls.install++;return {success:true}}," +
    "login:async()=>({success:true,data:{user:{id:'fixture-user',name:'测试用户',email:'fixture@example.test'},enterprise:{id:'fixture-enterprise',name:'测试企业'}}})," +
    "getSubscriptions:async()=>({success:true,data:[]}),getEmployeeStatus:async()=>({success:true,data:[]}),getAllTasks:async()=>({success:true,tasks:[]})," +
    "getUnreadNotificationCount:async()=>({success:true,data:{count:0}}),listNotifications:async()=>({success:true,data:{items:[],total:0,offset:0,limit:20}})};" +
    "window.electronAPI=new Proxy(api,{get:(target,name)=>name in target?target[name]:String(name).startsWith('on')?()=>()=>{}:async()=>({success:false,error:{message:'测试服务未启用'}})});" +
    "createRoot(document.getElementById('root')).render(React.createElement(App));</script></body></html>"
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  for (const viewport of [{ width: 1440, height: 900 }, { width: 960, height: 640 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/__download-update-test', route => route.fulfill({ contentType: 'text/html', body: html }))
    await page.goto(origin + '/__download-update-test')
    assert.equal(await page.getByRole('button', { name: '客户端更新，打开更新面板' }).count(), 0, '登录页不显示更新入口')
    await page.getByLabel('邮箱', { exact: true }).fill('fixture@example.test')
    await page.getByLabel('密码', { exact: true }).fill('fixture-password')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.locator('.ent-shell').waitFor()
    const acknowledgement = page.getByRole('button', { name: '知道了', exact: true })
    if (await acknowledgement.isVisible()) await acknowledgement.click()
    assert.equal(await page.getByRole('button', { name: '客户端更新，打开更新面板' }).count(), 1,
      JSON.stringify({ errors, buttons: await page.getByRole('button').allTextContents() }))
    await page.getByRole('button', { name: '客户端更新，打开更新面板' }).click()
    const viewNotes = page.getByRole('button', { name: '查看更新内容', exact: true })
    await viewNotes.waitFor()
    assert.equal(await viewNotes.getAttribute('aria-expanded'), 'false')
    await page.screenshot({ path: fileURLToPath(new URL('collapsed-' + viewport.width + '.png', screenshots)) })
    await page.context().setOffline(true)
    await viewNotes.click()
    const currentNotesRegion = page.getByRole('region', { name: '当前版本更新内容', exact: true })
    await currentNotesRegion.getByRole('heading', { name: currentVersion + ' 更新内容', exact: true }).waitFor()
    assert.equal(await currentNotesRegion.getByRole('heading', { name: firstHeading, exact: true }).isVisible(), true)
    await page.getByRole('button', { name: '收起更新内容', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: fileURLToPath(new URL('expanded-' + viewport.width + '.png', screenshots)) })
    const panelBounds = await page.locator('.ent-update-panel').boundingBox()
    assert.ok(panelBounds && panelBounds.x >= 0 && panelBounds.x + panelBounds.width <= viewport.width)
    assert.ok(panelBounds.y >= 0 && panelBounds.y + panelBounds.height <= viewport.height)
    assert.equal(await currentNotesRegion.evaluate(region => region.scrollHeight > region.clientHeight), true)
    assert.equal(await page.locator('.ent-update-panel').evaluate(panel => panel.scrollWidth <= panel.clientWidth), true)
    await page.getByRole('button', { name: '收起更新内容', exact: true }).click()
    assert.equal(await currentNotesRegion.count(), 0)
    await page.context().setOffline(false)
    await page.getByRole('button', { name: '检查更新', exact: true }).click()
    const download = page.getByRole('button', { name: '下载新版', exact: true })
    await download.waitFor()
    assert.equal(await page.getByRole('region', { name: '更新说明' }).getByText('改进更新体验', { exact: true }).isVisible(), true)
    assert.equal(await page.getByText('此版本未提供更新说明。', { exact: true }).count(), 0)
    await page.getByRole('button', { name: '查看更新内容', exact: true }).click()
    assert.equal(await currentNotesRegion.getByRole('heading', { name: currentVersion + ' 更新内容', exact: true }).isVisible(), true)
    assert.equal(await page.getByRole('region', { name: '更新说明', exact: true }).getByText('改进更新体验', { exact: true }).isVisible(), true)
    await page.getByRole('button', { name: '收起更新内容', exact: true }).click()
    assert.equal(await page.getByText('浏览器将下载对应平台安装包。下载后退出客户端，再安装新版本。', { exact: true }).isVisible(), true)
    await download.click()
    await page.getByText('浏览器已打开下载页面。', { exact: true }).waitFor()
    assert.equal(await page.getByRole('region', { name: '更新说明' }).getByText('改进更新体验', { exact: true }).isVisible(), true)
    assert.equal(await page.getByRole('button', { name: '重启并安装', exact: true }).count(), 0)
    await page.getByRole('button', { name: '再次下载', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.updateCalls), { check: 1, download: 2, install: 0 })
    const button = await page.getByRole('button', { name: '再次下载', exact: true }).boundingBox()
    assert.ok(button && button.x >= 0 && button.x + button.width <= viewport.width)
    assert.deepEqual(errors, [])
    await page.close()
    log('PASS current release notes (offline, toggle, version isolation, layout) and browser download at ' + viewport.width + 'px')
  }
} finally {
  if (browser) await browser.close()
  await server.close()
}
