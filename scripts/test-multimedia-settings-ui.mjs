/* global window */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { log } from 'node:console'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const serve = process.argv.includes('--serve')
let html = ''
const server = await createServer({ configFile: 'vite.preview.config.ts', logLevel: 'error',
  server: { host: '127.0.0.1', port: serve ? 5175 : 0, strictPort: false },
  plugins: [{ name: 'multimedia-settings-fixture', configureServer(vite) {
    vite.middlewares.use('/__multimedia-test', (_request, response, next) => {
      if (!html) return next()
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end(html)
    })
  } }],
})
let browser
try {
  await server.listen()
  const origin = 'http://127.0.0.1:' + server.httpServer.address().port
  const main = await (await fetch(origin + '/main.tsx')).text()
  const reactUrl = main.match(/from "([^"]*react\.js[^"]*)"/)[1]
  const domUrl = main.match(/from "([^"]*react-dom_client[^"]*)"/)[1]
  html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
    import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
    await import('/index.css');await import('/styles/enterprise.css');
    const React=(await import('${reactUrl}')).default;const {createRoot}=(await import('${domUrl}')).default;
    const {ProfileSettingsDialog}=await import('/components/enterprise/ProfileSettingsDialog.tsx');
    const {sepRuntimeV3Fixture}=await import('/shared/fixtures/sep-media-runtime-v3.ts');
    const {videoRuntimeSchema}=await import('/shared/video-media.ts');
    const image=sepRuntimeV3Fixture('image');
    image.profiles=image.profiles.map(profile=>({...profile,displayName:'图片模型',capabilities:{referenceImage:true,cancel:false,recoverByRequestId:false},allowedAspectRatios:[]}));
    image.profiles.push({...image.profiles[0],profileId:'second-image',displayName:'备用图片模型',modelId:'second-model',modelDisplayName:'备用模型'});
    const data={image,imageError:null,video:videoRuntimeSchema.parse(sepRuntimeV3Fixture('video'))};
    const state=window.multimediaTest={calls:[],fail:false,failDirectory:false,empty:false,pause:false,pending:[]};
    window.electronAPI={
      getSubscriptions:async()=>state.failDirectory?{success:false,error:{message:'员工列表暂不可用'}}:{success:true,data:state.empty?[]:[{subscriptionId:'sub-a',name:'设计员工',status:'ACTIVE'},{subscriptionId:'sub-b',name:'运营员工',status:'ACTIVE'},{subscriptionId:'paused',name:'停用员工',status:'PAUSED'}]},
      getMultimediaSettings:async({subscriptionId})=>{
        state.calls.push(subscriptionId);
        const response=state.fail?{success:false,error:{message:'多媒体服务暂不可用'}}:{success:true,data:subscriptionId==='sub-a'?structuredClone(data):{image:null,imageError:null,video:null}};
        if(state.pause)await new Promise(resolve=>state.pending.push(resolve));return response;
      },
      getDefaultWorkspaceDirectory:async()=>({success:true,data:null})
    };
    createRoot(document.getElementById('root')).render(React.createElement('div',{className:'ent-shell'},React.createElement(ProfileSettingsDialog,{profile:null,userName:'测试用户',canManage:false,uploading:null,error:null,sidebarCollapsed:false,onToggleSidebar:()=>{},onUploadAvatar:async()=>{},onUploadLogo:async()=>{},onRefresh:async()=>{},onClose:()=>{},models:[]})));
    </script></body></html>`
  if (serve) {
    log('Multimedia settings preview (fixture data): ' + origin + '/__multimedia-test')
    await new Promise(() => {})
  }
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  await mkdir('artifacts/multimedia-settings', { recursive: true })
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/__multimedia-test', route => route.fulfill({ contentType: 'text/html', body: html }))
    await page.goto(origin + '/__multimedia-test')
    await page.getByRole('button', { name: '多媒体', exact: true }).click()
    await page.getByText('建议值：1024x1024、1536x1024、1024x1536', { exact: true }).waitFor()
    assert.equal(await page.getByLabel('硅基员工').locator('option').count(), 2)
    await page.getByLabel('模型配置').selectOption('second-image')
    await page.locator('.ent-multimedia-summary dd').filter({ hasText: '备用模型' }).waitFor()
    await page.getByLabel('模型配置').selectOption('image_example')
    await page.screenshot({ path: 'artifacts/multimedia-settings/desktop-' + viewport.width + '.png', fullPage: true })
    await page.getByRole('radio', { name: '视频', exact: true }).check()
    await page.getByText('允许值：video/mp4', { exact: true }).waitFor()
    assert.equal(await page.getByText('建议值：否、是', { exact: true }).isVisible(), true)
    const frameRate = page.locator('.ent-multimedia-parameters > div').filter({ has: page.locator('dt', { hasText: '帧率' }) })
    assert.equal(await frameRate.getByText('不支持', { exact: true }).isVisible(), true)
    await page.evaluate(() => { window.multimediaTest.pause = true })
    await page.getByRole('button', { name: '刷新多媒体信息' }).click()
    await page.waitForFunction(() => window.multimediaTest.pending.length === 1)
    await page.getByLabel('硅基员工').selectOption('sub-b')
    await page.waitForFunction(() => window.multimediaTest.pending.length === 2)
    await page.evaluate(() => { window.multimediaTest.pause = false; window.multimediaTest.pending.splice(1, 1)[0]() })
    await page.getByText('该员工暂无可用的视频能力', { exact: true }).waitFor()
    await page.evaluate(() => window.multimediaTest.pending.splice(0, 1)[0]())
    await page.waitForTimeout(100)
    assert.equal(await page.getByText('该员工暂无可用的视频能力', { exact: true }).isVisible(), true)
    await page.evaluate(() => { window.multimediaTest.fail = true })
    await page.getByRole('button', { name: '刷新多媒体信息' }).click()
    await page.getByRole('alert').filter({ hasText: '多媒体服务暂不可用' }).waitFor()
    await page.evaluate(() => { window.multimediaTest.fail = false })
    await page.getByLabel('硅基员工').selectOption('sub-a')
    await page.getByText('允许值：video/mp4', { exact: true }).waitFor()
    const overflow = await page.locator('.ent-settings-content').evaluate(element => element.scrollWidth > element.clientWidth)
    assert.equal(overflow, false, 'settings content should fit viewport')
    const bounds = await page.getByLabel('硅基员工').boundingBox()
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width)
    await page.getByLabel('搜索设置').fill('视频 参数')
    await page.getByRole('heading', { name: '多媒体 / 图片与视频' }).waitFor()
    await page.evaluate(() => { window.multimediaTest.empty = true })
    await page.getByRole('button', { name: '刷新多媒体信息' }).click()
    await page.getByText('暂无可用的硅基员工', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: '刷新多媒体信息' }).isEnabled(), true)
    await page.evaluate(() => { window.multimediaTest.failDirectory = true })
    await page.getByRole('button', { name: '刷新多媒体信息' }).click()
    await page.getByRole('alert').filter({ hasText: '员工列表暂不可用' }).waitFor()
    assert.deepEqual(errors, [])
    await page.close()
    log('PASS multimedia navigation, parameters, profiles, employee switching, stale responses, refresh, errors and viewport ' + viewport.width)
  }
} finally {
  if (browser) await browser.close()
  await server.close()
}
