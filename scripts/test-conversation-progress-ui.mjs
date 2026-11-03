/* global window, document */
import assert from 'node:assert/strict'
import { log } from 'node:console'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const server = await createServer({ configFile: 'vite.preview.config.ts', logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } })
let browser
try {
  await server.listen()
  const address = server.httpServer.address()
  assert.ok(address && typeof address === 'object')
  const origin = `http://127.0.0.1:${address.port}`
  const main = await (await fetch(origin + '/main.tsx')).text()
  const reactUrl = main.match(/from "([^"]*react\.js[^"]*)"/)[1]
  const domUrl = main.match(/from "([^"]*react-dom_client[^" ]*)"/)[1]
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
    import RefreshRuntime from '/@react-refresh';
    RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
    await import('/index.css');await import('/styles/enterprise.css');await import('/styles/work-hub.css');
    const React=(await import('${reactUrl}')).default;const {createRoot}=(await import('${domUrl}')).default;
    const {WorkDetailPage}=await import('/pages/enterprise/WorkDetailPage.tsx');
    const {FeedbackProvider,useFeedback}=await import('/components/feedback/FeedbackProvider.tsx');
    const history=[];const listeners=new Set();let waiting=[];let currentRun='run';let preparing=true;
    window.emitConversation=(type,data)=>{const event={taskId:'task',runId:currentRun,subscriptionId:'employee',sequence:history.length+1,occurredAt:Date.now(),type,data};history.push(event);for(const listener of listeners)listener(event)};
    window.electronAPI={onPiEvent:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},
      listTaskRuns:async()=>({success:true,runs:[...new Set(history.map(event=>event.runId))].map(id=>({id,startedAt:1}))}),getTaskTimeline:async(_task,id)=>({success:true,events:history.filter(event=>event.runId===id)}),
      conversationQueue:async()=>({success:true,queue:{preparing,paused:false,items:waiting,failed:null}}),
      getTaskMedia:async()=>({success:true,data:{jobs:[],assets:[],references:[],profiles:[],videoJobs:[],videoAssets:[]}}),cancelAttachmentImport:async()=>({success:true}),
      beginAttachmentImport:async()=>({success:true,data:{schemaVersion:1,sessionId:'session',status:'open',attachments:[],revision:0,owner:{memberId:'member',enterpriseId:'enterprise'},target:{kind:'compose',composerId:'conversation-task'},createdAt:1,expiresAt:9999999999999}}),
      onAttachmentPaste:()=>()=>{},onAttachmentPasteStarted:()=>()=>{},onAttachmentPasteResult:()=>()=>{},
      onAttachmentImportUpdated:()=>()=>{},onAttachmentImport:()=>()=>{},
      continueTask:async input=>{waiting.push({id:input.messageId,prompt:input.prompt,createdAt:Date.now(),attachmentNames:[]});return {success:true}}
    };
    const initial={id:'task',title:'电商选品分析',goal:'分析智能行李箱的电商机会',kind:'conversation',workType:{state:'resolved',kind:'conversation'},status:'arranging',progress:0,
      currentEmployeeId:'employee',currentEmployeeName:'电商分析师',steps:[],nextUserAction:null,createdAt:1,startedAt:null,completedAt:null,updatedAt:1,isActive:false,activeRunId:null,
      participants:[],deliverables:[],timeline:[],messages:[{id:'first',role:'user',content:'分析智能行李箱的电商机会',createdAt:1}],activities:[],
      sharedContext:{goal:'分析智能行李箱的电商机会',confirmedInputs:[],previousResults:[],userNotes:[]},stopReason:null,workDir:null};
    function Fixture(){const [work,setWork]=React.useState(initial);const [show,setShow]=React.useState(true);const feedback=useFeedback();
      window.startConversationRun=()=>{preparing=false;setWork(current=>({...current,status:'running',isActive:true,activeRunId:'run',messages:current.messages.map(message=>({...message,runId:'run'}))}))};
      window.updateConversationReply=(content,complete=false)=>setWork(current=>({...current,status:complete?'completed':'running',isActive:!complete,activeRunId:complete?null:currentRun,lastRunId:complete?currentRun:current.lastRunId,
        messages:[...current.messages.filter(message=>message.role!=='employee'||message.runId!==currentRun),{id:complete?currentRun+'-answer':'task-streaming',role:'employee',runId:currentRun,employeeId:'employee',employeeName:'电商分析师',content,createdAt:Date.now()}]}));
      window.startNextConversationRun=()=>{currentRun='run-next';waiting=[];setWork(current=>({...current,status:'running',isActive:true,activeRunId:currentRun,messages:[...current.messages,{id:'second',role:'user',runId:currentRun,content:'补充一份竞品对比',createdAt:Date.now()}]}))};
      window.showConversationPage=value=>setShow(value);
      const workspace={works:[work],employees:[],myEmployees:[{id:'employee',name:'电商分析师'}],busy:false,canGoBack:false,attachmentScopeKey:'enterprise:member',
        retryWorkTypes(){},navigate(){},goBack(){},async sendMessage(taskId,prompt,_attachments,_session,_knowledge,messageId){
          const result=await window.electronAPI.continueTask({taskId,prompt,messageId});if(result.success)feedback.show({message:'任务已加入队列',tone:'success'});return result.success},
        stopWork(){},switchEmployee(){},deleteWork(){},retryWork(){}};
      return React.createElement('div',{className:'ent-shell ent-work-shell',style:{height:'100dvh'}},React.createElement('main',{className:'ent-work-hub',style:{height:'100%',display:'flex',flexDirection:'column'}},show?React.createElement(WorkDetailPage,{workspace,workId:'task'}):React.createElement('p',null,'其他页面')))
    }
    createRoot(document.getElementById('root')).render(React.createElement(FeedbackProvider,null,React.createElement(Fixture)));
  </script></body></html>`
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  await mkdir('output/playwright/conversation-progress', { recursive: true })
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    const errors = []
    page.on('pageerror', error => { errors.push(error.message); log('PAGE ERROR: ' + error.stack) })
    await page.route('**/__conversation-progress-test', route => route.fulfill({ contentType: 'text/html', body: html }))
    await page.goto(origin + '/__conversation-progress-test')
    await page.getByText('正在准备执行，请稍候…', { exact: true }).waitFor()
    await page.locator('[data-conversation-reply]').getByText('正在进行…', { exact: true }).waitFor()
    assert.equal(await page.locator('[data-conversation-reply]').count(), 1)
    assert.equal(await page.locator('.ent-talk > .ent-conversation-process').count(), 0)
    await page.evaluate(() => {
      window.startConversationRun()
      window.emitConversation('thinking_delta', { text: '正在分析市场需求。' })
      window.emitConversation('tool_execution_start', { toolId: 'read', toolName: 'read', input: { password: 'NEVER_SHOW' } })
    })
    const firstReply = page.locator('[data-conversation-reply][data-run-id="run"]')
    const process = firstReply.locator('.ent-conversation-process')
    assert.equal(await process.getAttribute('open'), null)
    await process.locator(':scope > summary').click()
    await process.locator('.ent-conversation-operation > span').filter({ hasText: '读取文件' }).waitFor()
    assert.equal(await page.getByText('正在分析市场需求。', { exact: true }).isVisible(), false)
    await process.locator('.ent-conversation-thinking > summary').click()
    await page.getByText('正在分析市场需求。', { exact: true }).waitFor()
    assert.equal(await page.locator('body').textContent().then(text => text.includes('NEVER_SHOW')), false)
    await page.evaluate(() => window.emitConversation('tool_execution_end', { toolId: 'read', toolName: 'read', success: true }))
    await process.getByText('已完成', { exact: true }).waitFor()
    await page.evaluate(() => window.updateConversationReply('正在整理市场分析结果'))
    await firstReply.getByText('正在整理市场分析结果', { exact: true }).waitFor()
    assert.equal(await process.getAttribute('open'), '')
    await page.evaluate(() => window.updateConversationReply('市场分析已完成', true))
    await firstReply.getByText('市场分析已完成', { exact: true }).waitFor()
    assert.equal(await process.getAttribute('open'), '')
    assert.equal(await page.locator('[data-conversation-reply]').count(), 1)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    const bounds = await process.boundingBox()
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width, 'work process must fit the viewport')
    await page.screenshot({ path: `output/playwright/conversation-progress/${width}-expanded.png` })
    await page.evaluate(() => window.showConversationPage(false))
    await page.getByText('其他页面', { exact: true }).waitFor()
    await page.evaluate(() => window.emitConversation('thinking_delta', { text: '离开页面后仍在继续分析。' }))
    await page.evaluate(() => window.showConversationPage(true))
    await process.waitFor()
    assert.equal(await process.getAttribute('open'), null)
    await process.locator(':scope > summary').click()
    await process.locator('.ent-conversation-thinking').last().locator('summary').click()
    await page.getByText('离开页面后仍在继续分析。', { exact: true }).waitFor()
    await process.locator(':scope > summary').click()
    await page.getByRole('textbox', { name: '给员工的下一句话' }).fill('补充一份竞品对比')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.getByRole('dialog').getByText('任务已加入队列', { exact: true }).waitFor()
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByText('等待处理 1/10', { exact: true }).waitFor()
    assert.equal(await page.locator('[data-conversation-reply]').count(), 1, 'waiting work must not look active')
    await page.evaluate(() => window.startNextConversationRun())
    const secondReply = page.locator('[data-conversation-reply][data-run-id="run-next"]')
    await secondReply.getByText('正在进行…', { exact: true }).waitFor()
    assert.equal(await page.locator('[data-conversation-reply]').count(), 2)
    await page.evaluate(() => window.emitConversation('thinking_delta', { text: '第二轮正在对比竞品。' }))
    const secondProcess = secondReply.locator('.ent-conversation-process')
    assert.equal(await secondProcess.getAttribute('open'), null)
    assert.equal(await firstReply.textContent().then(text=>text.includes('第二轮正在对比竞品。')), false)
    await secondProcess.locator(':scope > summary').click()
    await secondProcess.locator('.ent-conversation-thinking > summary').click()
    await secondReply.getByText('第二轮正在对比竞品。', { exact: true }).waitFor()
    await secondProcess.locator(':scope > summary').click()
    await page.evaluate(() => window.showConversationPage(false))
    await page.getByText('其他页面', { exact: true }).waitFor()
    await page.evaluate(() => window.showConversationPage(true))
    await secondProcess.waitFor()
    assert.equal(await secondProcess.getAttribute('open'), null)
    assert.equal(await firstReply.locator('.ent-conversation-process').getAttribute('open'), null)
    await page.screenshot({ path: `output/playwright/conversation-progress/${width}-folded.png` })
    assert.deepEqual(errors, [])
    log(`PASS conversation progress: ${width}px, immediate reply, per-run folded process, stable streaming, two-run replay, enqueue feedback`)
    await page.close()
  }
} finally {
  await browser?.close()
  await server.close()
}
