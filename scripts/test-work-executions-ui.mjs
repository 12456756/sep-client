/* global window */
import assert from 'node:assert/strict'
import { log } from 'node:console'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

// Real navigation and detail components with local execution fixtures; no model calls.
const server = await createServer({ configFile: 'vite.preview.config.ts', logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } })
let browser
const screenshots = await mkdtemp(join(tmpdir(), 'sep-work-executions-ui-'))
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  const main = await (await fetch(`${origin}/main.tsx`)).text()
  const reactUrl = main.match(/from "([^"]*react\.js[^"]*)"/)[1]
  const domUrl = main.match(/from "([^"]*react-dom_client[^"]*)"/)[1]
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
    import RefreshRuntime from '/@react-refresh';
    RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
    const React=(await import('${reactUrl}')).default;
    const {createRoot}=(await import('${domUrl}')).default;
    const {WorkHubPage}=await import('/pages/enterprise/WorkHubPage.tsx');
    const {FeedbackProvider}=await import('/components/feedback/FeedbackProvider.tsx');
    const {buildWorkItem}=await import('/features/enterprise/work-mapping.ts');
    await import('/index.css');await import('/styles/enterprise.css');
    window.electronAPI=new Proxy({onPiEvent:()=>()=>{},listTaskRuns:async()=>({success:true,runs:[]})},{get:(target,key)=>target[key]??(String(key).startsWith('on')?()=>()=>{}:async()=>({success:true,data:[]}))});
    const task={id:'root',title:'智能行李箱策划案',prompt:'为智能行李箱编写策划案',status:'completed',workDir:'D:/work/root',createdAt:1793581200000,startedAt:1793581200000,completedAt:1793581260000,error:null,files:[],logs:[],ownerId:'member',ownerEnterpriseId:'enterprise',subscriptionId:'employee',activeRunId:null,workType:{state:'resolved',kind:'arrangement'}};
    const first=buildWorkItem({task,employees:[]});
    first.recordKey='draft-root';
    const second=buildWorkItem({task:{...task,id:'second',createdAt:task.createdAt+3600000,startedAt:task.startedAt+3600000,completedAt:task.completedAt+3600000,workDir:'D:/work/second',executionGroup:{rootTaskId:'root',number:2}},employees:[]});
    function Fixture(){
      const [route,navigate]=React.useState({name:'work',workId:'draft-root'});
      const [works,setWorks]=React.useState([first]);
      const [busy,setBusy]=React.useState(false);
      window.setExecutionFixture=count=>{setWorks(count===1?[first]:[first,second]);navigate({name:'work',workId:'root'})};
      const workspace={works,route,navigate,replaceRoute:navigate,attachmentScopeKey:'enterprise:member',employees:[],myEmployees:[],templates:[],savedFlows:[],arrangeSeed:null,seedArrange:()=>{},busy,canGoBack:false,chooseFolder:async()=>null,
        retryWorkTypes:()=>{},renameWork:async()=>true,setWorkPinned:async()=>true,deleteWork:async()=>true,retryWork:async()=>{throw new Error('resume must not be used for re-execution')},
        rerunWork:async()=>{setBusy(true);setWorks([first,second]);navigate({name:'work',workId:'root',executionTaskId:'second'});setBusy(false)},stopWork:async()=>true};
      return React.createElement(FeedbackProvider,null,React.createElement('div',{className:'ent-shell ent-work-shell',style:{height:'100vh'}},React.createElement(WorkHubPage,{workspace})));
    }
    createRoot(document.getElementById('root')).render(React.createElement(Fixture));
  </script></body></html>`
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/__execution-test', route => route.fulfill({ contentType: 'text/html', body: html }))
    await page.goto(`${origin}/__execution-test`)
    await page.getByRole('region', { name: '编排执行过程' }).waitFor()
    assert.equal(await page.getByRole('region', { name: '运行记录', exact: true }).count(), 0)
    if (viewport.width < 1180) await page.getByRole('button', { name: '展开工作列表' }).click()
    await page.getByRole('button', { name: '更多操作：智能行李箱策划案' }).click()
    await page.getByRole('menuitem', { name: '重新执行', exact: true }).click()
    await page.getByRole('button', { name: '返回运行记录', exact: true }).waitFor()
    await page.getByRole('button', { name: '返回运行记录', exact: true }).click()
    const list = page.getByRole('region', { name: '运行记录', exact: true })
    await list.waitFor()
    assert.equal(await list.getByRole('button').count(), 2)
    assert.match(await list.getByRole('button').first().textContent(), /第2次运行/)
    assert.equal(await page.locator('.ent-work-row').count(), 1)
    if (viewport.width < 1180) await page.getByRole('button', { name: '收起工作列表' }).click()
    await page.screenshot({ path: join(screenshots, `work-executions-${viewport.width}.png`), fullPage: true })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    const overlaps = await list.locator('button').evaluateAll(buttons => buttons.some(button => button.scrollWidth > button.clientWidth + 1))
    assert.equal(overlaps, false)
    await list.getByRole('button').filter({ hasText: '第1次运行' }).click()
    await page.getByRole('region', { name: '编排执行过程' }).waitFor()
    await page.getByRole('button', { name: '查看工作信息', exact: true }).click()
    await page.getByText('D:/work/root', { exact: true }).first().waitFor()
    await page.getByRole('button', { name: '关闭详情面板', exact: true }).click()
    await page.getByRole('button', { name: '返回运行记录', exact: true }).click()
    await list.getByRole('button').filter({ hasText: '第2次运行' }).click()
    await page.getByRole('button', { name: '查看工作信息', exact: true }).click()
    await page.getByText('D:/work/second', { exact: true }).first().waitFor()
    assert.deepEqual(errors, [])
    log(`PASS execution navigation: ${viewport.width}x${viewport.height}`)
    await page.close()
  }
  log(`Screenshots: ${screenshots}`)
} finally {
  await browser?.close()
  await server.close()
}
