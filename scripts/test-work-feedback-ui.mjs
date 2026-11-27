/* global window, document, requestAnimationFrame */
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { log } from 'node:console'
import { chromium } from 'playwright-core'

const origin = process.env.SEP_PREVIEW_ORIGIN ?? 'http://127.0.0.1:5184'
const referenceUploadOnly = process.argv.includes('--reference-upload-only')
const scheduleOnly = process.argv.includes('--schedule-only')
const main = await (await fetch(origin + '/main.tsx')).text()
const react = main.match(/from "([^"]*react\.js[^"]*)"/)[1]
const dom = main.match(/from "([^"]*react-dom_client[^"]*)"/)[1]
const html = String.raw`<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
await import('/index.css');await import('/styles/enterprise.css');await import('/components/workspace/media-artifacts.css');
const React=(await import('${react}')).default;const {createRoot}=(await import('${dom}')).default;
const {FeedbackProvider,useFeedback}=await import('/components/feedback/FeedbackProvider.tsx');
const {useEnterpriseWorkspace}=await import('/features/enterprise/useEnterpriseWorkspace.ts');
const {MediaArtifactsPanel}=await import('/components/workspace/MediaArtifactsPanel.tsx');
const {ToolApprovalDialog}=await import('/components/ToolApprovalDialog.tsx');
const {CREATE_SCHEDULED_TASK_TOOL}=await import('/shared/scheduled-creation.ts');
const {InlineFileApproval,InlineFileApprovals,isInlineFileApproval}=await import('/components/enterprise/InlineFileApproval.tsx');
const {default:DocumentPreviewDialog}=await import('/components/workspace/DocumentPreviewDialog.tsx');
const task={id:'task-a',title:'工作名称',prompt:'测试',status:'completed',createdAt:1,updatedAt:1,completedAt:2,activeRunId:null,ownerId:'member',ownerEnterpriseId:'enterprise',subscriptionId:'sub',files:[],logs:[],workType:{state:'resolved',kind:'conversation'}};
const asset={localAssetId:'asset-a',taskId:'task-a',source:'output',status:'SAVED',mime:'image/png',width:20,height:20};
const job={jobId:'job-a',taskId:'task-a',profileId:'profile',operation:'generate',parameters:{aspectRatio:'1:1',count:1},generationStatus:'FAILED',trackingStatus:'STOPPED',saveStatus:'PENDING',billingStatus:null,error:'NETWORK_TIMEOUT',assets:[],createdAt:1,updatedAt:1};
window.calls={rename:0,delete:0,stop:0,approve:0,deny:0,revise:0,export:0};window.mode='actions';
window.electronAPI={
getEnterpriseOrganization:async()=>({success:true,data:{enterprise:{id:'enterprise',name:'企业',logo:null},departments:[],members:[],grants:[],employees:[]}}),
listSkillLibrary:async()=>({success:true,data:[]}),getAllTasks:async()=>({success:true,tasks:[task]}),getTask:async()=>({success:true,task}),getTaskMessages:async()=>({success:true,messages:[]}),
getArrangementPlan:async()=>({success:true,plan:null}),getTaskTimeline:async()=>({success:true,events:[]}),
onTaskListUpdated:()=>()=>{},onTaskUpdated:()=>()=>{},onPiEvent:()=>()=>{},
updateTaskDetails:async patch=>{window.calls.rename++;return new Promise(resolve=>{window.finishRename=()=>resolve({success:false,error:{message:'工作名称保存失败，请联系平台管理员'}})});},
deleteTask:async()=>{window.calls.delete++;return {success:true}},cancelTask:async()=>{window.calls.stop++;return {success:true}},
getTaskVideo:async()=>({success:true,data:null}),getTaskMedia:async()=>({success:true,data:{capabilities:null,assets:[asset],jobs:window.includeJob?[job]:[],selectedReferenceIds:[],archived:false}}),
previewMediaAsset:async()=>window.previewFail?({success:false,error:{message:'图片预览失败，请联系平台管理员'}}):({success:true,data:{mime:'image/png',bytes:Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY5cAAAAASUVORK5CYII='),c=>c.charCodeAt(0))}}),
previewArrangementDocument:async()=>new Promise(resolve=>{window.finishPreview=()=>resolve({success:false,error:{message:'文档预览失败，请联系平台管理员'}})}),
exportMediaAsset:async()=>{window.calls.export++;return {success:true,cancelled:false}},
};
function Harness(){const workspace=useEnterpriseWorkspace({userId:'member',userName:'用户',enterpriseId:'enterprise',enterpriseName:'企业',instances:[],employeeStatuses:[]});
window.workspace=workspace;window.feedback=useFeedback();const [mode,setMode]=React.useState('actions');const [approval,setApproval]=React.useState(null);window.setMode=setMode;window.setApproval=setApproval;
const approve=React.useCallback(()=>{window.calls.approve++;setApproval(null)},[]);const deny=React.useCallback(()=>{window.calls.deny++;setApproval(null)},[]);
const revise=React.useCallback(()=>{window.calls.revise++;setApproval(null)},[]);
const inline=approval&&isInlineFileApproval(approval.toolName);
return React.createElement('main',null,
mode==='schedule'?React.createElement('button',{onClick:()=>setApproval({toolName:CREATE_SCHEDULED_TASK_TOOL,requestId:'schedule-review',expiresAt:Date.now()+60_000,input:{title:'每日销售统计',goal:'读取钉钉 AI 表格「销售1」，汇总销售数据。通过钉钉发送文档给示例收件人。'+(window.longSchedule?'\n\n'+('核实数据与发送权限。'.repeat(10)+'\n\n').repeat(55):'\n\n核实数据范围、异常记录与收件人权限；不重复发送结果不确定的内容。')+'\n\nDeliverables:\n- 销售统计文档',timezone:'Asia/Shanghai',firstRunAt:Date.UTC(2026,10,27,10,5),recurrence:'5 18 * * *',executor:'通用助手'}})},'打开定时任务确认'):null,
mode==='actions'?React.createElement('div',null,React.createElement('button',{onClick:()=>workspace.renameWork('task-a')},'重命名'),React.createElement('button',{onClick:()=>workspace.deleteWork('task-a')},'删除工作'),React.createElement('button',{onClick:()=>workspace.stopWork('task-a','用户终止')},'终止工作')):null,
mode==='media'?React.createElement(MediaArtifactsPanel,{taskId:'task-a'}):null,
mode==='document'?React.createElement(DocumentPreviewDialog,{taskId:'task-a',nodeId:'node',deliverableId:'doc',name:'测试文档',onClose:()=>setMode('actions')}):null,
inline?React.createElement(InlineFileApprovals.Provider,{value:{requests:[approval],resolve:(id,accepted)=>{if(id===approval.requestId)(accepted?approve:deny)()}}},React.createElement(InlineFileApproval,{taskId:'task-a'})):approval?React.createElement(ToolApprovalDialog,{request:approval,onApprove:approve,onDeny:deny,onReviseScheduleTime:revise}):null);}
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(FeedbackProvider,null,React.createElement(Harness))));
</script></body></html>`
const browser = await chromium.launch({ channel: process.env.SEP_BROWSER_CHANNEL || 'chrome', headless: true })
let checks = 0
try {
  for (const width of [1200, 375]) {
    const page = await browser.newPage({ viewport: { width, height: 800 }, reducedMotion: 'reduce' })
    const errors = []
    page.on('pageerror', error => { errors.push(error.message); log('Page error: ' + error.stack) })
    page.on('response', response => { if (response.status() >= 400) log('HTTP ' + response.status() + ' ' + response.url()) })
    page.setDefaultTimeout(10_000)
    await page.route('**/__work-feedback-test', route => route.fulfill({ contentType: 'text/html', body: html }))
    const reset = async () => { await page.goto(origin + '/__work-feedback-test'); await page.getByRole('button', { name: '重命名', exact: true }).waitFor(); await page.waitForFunction(() => window.workspace.works.length === 1) }
    const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const notice = async message => {
      const dialog = page.locator('.feedback-dialog').filter({ hasText: message }); await dialog.waitFor()
      assert.equal(await page.locator('.feedback-dialog').count(), 1)
      const bounds = await dialog.boundingBox()
      assert.ok(bounds.x >= 15 && bounds.x + bounds.width <= width - 15)
      assert.equal(await dialog.evaluate(element => element.scrollWidth > element.clientWidth), false)
      return dialog
    }
    const dismiss = () => page.getByRole('button', { name: '知道了', exact: true }).click()

    if (!referenceUploadOnly) {
      for (const theme of ['light', 'dark']) {
        await reset()
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; window.setMode('schedule') }, theme)
        const trigger = page.getByRole('button', { name: '打开定时任务确认' })
        const dialog = page.getByRole('dialog', { name: '创建并启用定时任务？' })
        const focused = page.locator(':focus')
        const cancel = dialog.getByRole('button', { name: '取消', exact: true })
        const facts = dialog.getByRole('region', { name: '执行安排' })
        const details = dialog.getByRole('region', { name: '完整执行说明' })
        await trigger.press('Enter')
        await dialog.and(focused).waitFor()
        assert.equal(await dialog.evaluate(element => window.getComputedStyle(element).outlineStyle), 'none')
        if (process.env.SEP_SCHEDULE_SCREENSHOT_DIR) {
          await dialog.screenshot({ path: join(process.env.SEP_SCHEDULE_SCREENSHOT_DIR, `schedule-${theme}-${width}.png`) })
        }
        await page.keyboard.press('Enter')
        await frames()
        assert.deepEqual(await page.evaluate(() => [window.calls.approve, window.calls.deny, window.calls.revise]), [0, 0, 0])
        await page.keyboard.press('Tab')
        await facts.and(focused).waitFor()
        await page.keyboard.press('Tab')
        await details.and(focused).waitFor()
        await page.keyboard.press('Tab')
        await cancel.and(focused).waitFor()
        assert.notEqual(await cancel.evaluate(element => window.getComputedStyle(element).outlineStyle), 'none')
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'hidden' })
        await page.waitForFunction(() => window.calls.deny === 1)
        await trigger.and(focused).waitFor()
        await page.evaluate(() => { window.longSchedule = true })
        await trigger.click()
        await dialog.and(focused).waitFor()
        assert.match(await facts.innerText(), /预计首次执行\s*2026年11月27日 18:05/)
        assert.match(await facts.innerText(), /每天 18:05/)
        assert.match(await details.innerText(), /示例收件人/)
        assert.match(await details.innerText(), /交付成果\s*- 销售统计文档$/)
        const left = await facts.boundingBox()
        const right = await details.boundingBox()
        if (width > 540) assert.ok(left.x < right.x && left.y === right.y)
        else assert.ok(left.x === right.x && left.y < right.y)
        assert.equal(await dialog.evaluate(element => element.scrollWidth > element.clientWidth), false)
        const footer = dialog.locator('footer')
        const before = await footer.boundingBox()
        const scrollable = width > 540 ? details : dialog.locator('.feedback-review-body')
        assert.equal(await scrollable.evaluate(element => {
          element.scrollTop = element.scrollHeight
          return element.scrollTop > 0
        }), true)
        assert.deepEqual(await footer.boundingBox(), before)
        await dialog.getByRole('button', { name: '修改时间' }).click()
        await page.waitForFunction(() => window.calls.revise === 1)
        assert.equal(await page.evaluate(() => window.calls.approve), 0)
        await trigger.click()
        await dialog.getByRole('button', { name: '创建并启用' }).click()
        await page.waitForFunction(() => window.calls.approve === 1)
        assert.deepEqual(errors, [])
        checks++
      }
      if (scheduleOnly) { await page.close(); continue }
    }

    await reset()
    for (const [index, toolName] of ['video_from_image', 'media_generate_image', 'video_generate'].entries()) {
      await page.evaluate(toolName => window.setApproval({ taskId: 'task-a', requestId: 'upload', toolName,
        input: { mock: false, operation: 'upload-references', referenceCount: 1 }, timestamp: Date.now(), expiresAt: Date.now() + 60_000 }), toolName)
      await page.waitForFunction(expected => window.calls.deny === expected, index + 1)
      assert.equal(await page.getByRole('region', { name: '参考图上传审批' }).count(), 0)
      assert.equal(await page.locator('.feedback-dialog, .feedback-overlay').count(), 0)
      assert.equal(await page.evaluate(() => window.calls.approve), 0); checks++
    }
    if (referenceUploadOnly) {
      assert.deepEqual(errors, [])
      await page.close()
      continue
    }

    await reset()
    await page.getByRole('button', { name: '删除工作', exact: true }).click()
    await notice('确认删除这条工作记录')
    await page.getByRole('button', { name: '取消', exact: true }).click()
    assert.equal(await page.evaluate(() => window.calls.delete), 0); checks++
    await page.getByRole('button', { name: '重命名', exact: true }).click()
    await page.getByRole('textbox', { name: '工作名称', exact: true }).fill('   ')
    await page.getByRole('button', { name: '保存名称', exact: true }).click()
    await page.getByRole('alert').waitFor()
    assert.equal(await page.evaluate(() => window.calls.rename), 0)
    await page.getByRole('textbox', { name: '工作名称', exact: true }).fill('新名称')
    await page.getByRole('button', { name: '保存名称', exact: true }).click()
    await page.evaluate(() => { const button = document.querySelector('.feedback-primary'); button.click(); button.click() })
    assert.equal(await page.evaluate(() => window.calls.rename), 1)
    await page.evaluate(() => window.finishRename())
    await notice('工作名称保存失败，请联系平台管理员')
    await page.screenshot({ path: join(tmpdir(), 'sep-work-feedback-' + width + '.png') })
    await page.waitForTimeout(2100)
    assert.equal(await page.locator('.feedback-dialog').count(), 1)
    await dismiss(); checks++

    await reset()
    await page.evaluate(() => { window.includeJob = true; window.setMode('media') })
    await notice('网络连接超时，请稍后重试'); await dismiss()
    await page.waitForTimeout(3300)
    assert.equal(await page.locator('.feedback-dialog').count(), 0); checks++
    await page.evaluate(() => { window.previewFail = true })
    await page.getByRole('button', { name: '放大查看成果 1', exact: true }).click()
    await notice('图片预览失败，请联系平台管理员')
    assert.equal(await page.locator('dialog[data-feedback-host]').count(), 1)
    await page.keyboard.press('Escape'); await frames()
    assert.equal(await page.locator('.feedback-dialog').count(), 0)
    assert.equal(await page.locator('.media-preview-dialog[open]').count(), 1)
    await page.getByRole('button', { name: '导出图片', exact: true }).click()
    await notice('图片已导出')
    await page.waitForTimeout(2200)
    assert.equal(await page.locator('.feedback-dialog').count(), 0); checks++

    await reset()
    await page.evaluate(() => window.setMode('document'))
    await page.waitForFunction(() => typeof window.finishPreview === 'function')
    await page.evaluate(() => { window.feedback.clear(); window.finishPreview() })
    await frames(); assert.equal(await page.locator('.feedback-dialog').count(), 0); checks++

    await reset()
    await page.evaluate(() => { window.feedback.show({tone:'error',message:'前一条错误'}); window.setApproval({requestId:'expires',toolName:'bash',input:{command:'pwd'},timestamp:Date.now(),expiresAt:Date.now()+500}) })
    await notice('前一条错误'); await page.waitForFunction(() => window.calls.deny === 1)
    await dismiss(); await frames()
    assert.equal(await page.locator('.feedback-dialog').count(), 0)
    assert.equal(await page.evaluate(() => window.calls.approve), 0); checks++
    await page.evaluate(() => window.setApproval({requestId:'paid',toolName:'video_generate',input:{mock:false,quote:{amount:'1.230000',currency:'CNY'}},timestamp:Date.now(),expiresAt:Date.now()+60_000}))
    await page.waitForFunction(() => window.calls.deny === 2)
    assert.equal(await page.locator('.feedback-dialog').count(), 0); checks++
    await page.evaluate(() => window.setApproval({requestId:'bad-price',toolName:'video_generate',input:{mock:false,quote:{amount:'bad',currency:'CNY'}},timestamp:Date.now(),expiresAt:Date.now()+60_000}))
    await page.waitForFunction(() => window.calls.deny === 3)
    assert.equal(await page.locator('.feedback-dialog').count(), 0); checks++

    await reset()
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark')
    await page.getByRole('button', { name: '终止工作', exact: true }).click()
    await notice('确认终止当前对话任务')
    await page.screenshot({ path: join(tmpdir(), 'sep-work-feedback-dark-' + width + '.png') })
    await page.keyboard.press('Escape'); await frames()
    assert.equal(await page.evaluate(() => window.calls.stop), 0); checks++
    assert.deepEqual(errors, [])
    await page.close()
  }
  log('work feedback UI: ' + checks + ' checks passed at desktop and mobile widths')
} finally { await browser.close() }
