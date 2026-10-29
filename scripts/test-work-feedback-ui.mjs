/* global window, document, requestAnimationFrame */
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
const html = `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
await import('/index.css');await import('/styles/enterprise.css');await import('/components/workspace/media-artifacts.css');
const React=(await import('${react}')).default;const {createRoot}=(await import('${dom}')).default;
const {FeedbackProvider,useFeedback}=await import('/components/feedback/FeedbackProvider.tsx');
const {useEnterpriseWorkspace}=await import('/features/enterprise/useEnterpriseWorkspace.ts');
const {MediaArtifactsPanel}=await import('/components/workspace/MediaArtifactsPanel.tsx');
const {ToolApprovalDialog}=await import('/components/ToolApprovalDialog.tsx');
const {default:DocumentPreviewDialog}=await import('/components/workspace/DocumentPreviewDialog.tsx');
const task={id:'task-a',title:'工作名称',prompt:'测试',status:'completed',createdAt:1,updatedAt:1,completedAt:2,activeRunId:null,ownerId:'member',ownerEnterpriseId:'enterprise',subscriptionId:'sub',files:[],logs:[],workType:{state:'resolved',kind:'conversation'}};
const asset={localAssetId:'asset-a',taskId:'task-a',source:'output',status:'SAVED',mime:'image/png',width:20,height:20};
const job={jobId:'job-a',taskId:'task-a',profileId:'profile',operation:'generate',parameters:{aspectRatio:'1:1',count:1},generationStatus:'FAILED',trackingStatus:'STOPPED',saveStatus:'PENDING',billingStatus:null,error:'NETWORK_TIMEOUT',assets:[],createdAt:1,updatedAt:1};
window.calls={rename:0,delete:0,stop:0,approve:0,deny:0,export:0};window.mode='actions';
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
return React.createElement('main',null,
mode==='actions'?React.createElement('div',null,React.createElement('button',{onClick:()=>workspace.renameWork('task-a')},'重命名'),React.createElement('button',{onClick:()=>workspace.deleteWork('task-a')},'删除工作'),React.createElement('button',{onClick:()=>workspace.stopWork('task-a','用户终止')},'终止工作')):null,
mode==='media'?React.createElement(MediaArtifactsPanel,{taskId:'task-a'}):null,
mode==='document'?React.createElement(DocumentPreviewDialog,{taskId:'task-a',nodeId:'node',deliverableId:'doc',name:'测试文档',onClose:()=>setMode('actions')}):null,
approval?React.createElement(ToolApprovalDialog,{request:approval,onApprove:approve,onDeny:deny}):null);}
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
    await notice('本次报价 ¥1.230000')
    await page.getByRole('button', { name: '同意并生成', exact: true }).click()
    await page.waitForFunction(() => window.calls.approve === 1); checks++
    await page.evaluate(() => window.setApproval({requestId:'bad-price',toolName:'video_generate',input:{mock:false,quote:{amount:'bad',currency:'CNY'}},timestamp:Date.now(),expiresAt:Date.now()+60_000}))
    await page.waitForFunction(() => window.calls.deny === 2)
    assert.equal(await page.locator('.feedback-dialog').count(), 0); checks++
    await page.evaluate(() => window.setApproval({requestId:'upload',toolName:'video_from_image',input:{mock:false,operation:'upload-references',referenceCount:1},timestamp:Date.now(),expiresAt:Date.now()+60_000}))
    await notice('允许上传所选参考图')
    await page.getByRole('button', { name: '允许', exact: true }).click()
    await page.waitForFunction(() => window.calls.approve === 2); checks++

    await reset()
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark')
    await page.getByRole('button', { name: '终止工作', exact: true }).click()
    await notice('确认终止当前工作')
    await page.screenshot({ path: join(tmpdir(), 'sep-work-feedback-dark-' + width + '.png') })
    await page.keyboard.press('Escape'); await frames()
    assert.equal(await page.evaluate(() => window.calls.stop), 0); checks++
    assert.deepEqual(errors, [])
    await page.close()
  }
  log('work feedback UI: ' + checks + ' checks passed at desktop and mobile widths')
} finally { await browser.close() }
