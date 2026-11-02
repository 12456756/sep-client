/* global window, document */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { log } from 'node:console'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { WorkDetailPage } from './src/pages/enterprise/WorkDetailPage';
import { FeedbackProvider } from './src/components/feedback/FeedbackProvider';
import { useArrangementPlans } from './src/features/enterprise/use-arrangement-plans';
import './src/styles/enterprise.css';
const candidate = { stepId:'research',employeeId:'researcher',subscriptionId:null,source:'platform',name:'市场分析员工',rationale:'具备市场调研与需求分析技能',canExecute:false,canApply:true };
let execution = {activeRunId:null,status:'waiting-employee',updatedAt:1,nodes:[{nodeId:'research',status:'waiting-employee',finalFiles:[],employeeReplacement:{nodeId:'research',originalSubscriptionId:'old',reason:'原员工已不可用，已有成果保留。',status:'waiting',updatedAt:1,candidates:[candidate]}},{nodeId:'peer',status:'waiting-employee',finalFiles:[],employeeReplacement:{nodeId:'peer',originalSubscriptionId:'old-peer',reason:'暂未找到合适的替代员工。',status:'waiting',updatedAt:1,candidates:[]}}]};
window.calls={apply:0,resume:0,retry:0};window.approved=false;
window.electronAPI={
getArrangementPlan:async()=>({success:true,plan:null}),getTaskTimeline:async()=>({success:true,events:[]}),listTaskRuns:async()=>({success:true,runs:[]}),onPiEvent:()=>()=>{},
getArrangementExecution:async()=>({success:true,execution:structuredClone(execution)}),
requestReplacementEmployeeAccess:async input=>{window.calls.apply++;execution.nodes[0].employeeReplacement.accessRequests=[{requestId:'req',stepId:input.nodeId,employeeId:input.employeeId,subscriptionId:null,source:'platform',name:'市场分析员工',status:'PENDING',requestedCapabilities:[],createdAt:'2026-11-02',updatedAt:'2026-11-02'}];return {success:true,execution:structuredClone(execution)};},
refreshReplacementEmployeeAccess:async()=>{if(window.approved&&!execution.activeRunId){window.calls.resume++;execution.activeRunId='resumed-run';execution.status='running';execution.nodes[0].status='running';execution.nodes[0].employeeReplacement.status='replaced';execution.nodes[0].employeeReplacement.replacementSubscriptionId='new';}return {success:true,execution:structuredClone(execution)};}
};
const tasks=[{id:'original-work',status:'paused',activeRunId:null,workType:{state:'resolved',kind:'arrangement'}}];
function Fixture(){const state=useArrangementPlans(tasks,'test-scope');const current=state.executions['original-work'];const work={id:'original-work',title:'智能行李箱策划案',goal:'为智能行李箱完成市场分析与上市策划',kind:'flow',workType:{state:'resolved',kind:'arrangement'},status:current?.status||'waiting-employee',isActive:!!current?.activeRunId,progress:30,createdAt:1,updatedAt:1,startedAt:1,completedAt:null,currentEmployeeId:'old',currentEmployeeName:'原员工',participants:[],deliverables:[],activities:[],timeline:[],messages:[],steps:[{id:'research',title:'市场分析',employeeId:'old',employeeName:'原员工',state:current?.nodes[0].status==='running'?'running':'waiting-employee'},{id:'peer',title:'产品策划',employeeId:'old-peer',employeeName:'产品员工',state:'waiting-employee'}],sharedContext:{goal:'策划案',confirmedInputs:[],previousResults:[],userNotes:[]},nextUserAction:null,stopReason:null,workDir:null,arrangementExecution:current};const workspace={works:[work],employees:[],myEmployees:[],busy:false,canGoBack:false,scopeKey:'test-scope',requestReplacementAccess:state.requestReplacementAccess,retryWork:async()=>{window.calls.retry++},stopWork:async()=>true};return <main className="ent-shell"><div className="ent-shell-main"><div className="ent-scroll"><WorkDetailPage workspace={workspace} workId={work.id}/></div></div></main>;}
createRoot(document.getElementById('root')).render(<FeedbackProvider><Fixture/></FeedbackProvider>);
`
const bundle = await build({ stdin: { contents: fixture, loader: 'tsx', resolveDir: process.cwd() }, bundle: true,
  write: false, outfile: 'fixture.js', format: 'iife', jsx: 'automatic', loader: { '.png': 'dataurl', '.svg': 'dataurl' },
  plugins: [{ name: 'unrelated-browser-assets', setup(builder) {
    builder.onResolve({ filter: /\?url$/ }, args => ({ path: args.path, namespace: 'asset-url' }))
    builder.onLoad({ filter: /.*/, namespace: 'asset-url' }, () => ({ contents: 'export default ""', loader: 'js' }))
    builder.onLoad({ filter: /[\\/]PdfDocumentPreview\.tsx$/ }, () => ({ contents: 'export function PdfDocumentPreview(){return null}', loader: 'js' }))
  } }],
  define: { 'process.env.NODE_ENV': JSON.stringify('development') } })
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text
const css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text
const server = createServer((request, response) => {
  if (request.url === '/fixture.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(js); return }
  if (request.url === '/fixture.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); return }
  response.setHeader('Content-Type', 'text/html')
  response.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{margin:0;height:100%;font:14px Arial}*{box-sizing:border-box}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const executablePath = [process.env.SEP_PREVIEW_BROWSER, `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['PROGRAMFILES(X86)']}\\Microsoft\\Edge\\Application\\msedge.exe`].filter(Boolean).find(existsSync)
let browser
try {
  browser = await chromium.launch({ executablePath, headless: true })
  const output = join(process.cwd(), 'output/employee-replacement')
  await mkdir(output, { recursive: true })
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.getByRole('button', { name: '申请员工' }).click()
    await page.getByRole('status').filter({ hasText: '已申请，等待审批' }).waitFor()
    assert.equal(await page.evaluate(() => window.calls.apply), 1)
    assert.equal(await page.getByRole('button', { name: '重新查找' }).count(), 2)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'page must fit viewport')
    await page.screenshot({ path: join(output, `${width}.png`), fullPage: true })
    await page.evaluate(() => { window.approved = true })
    await page.waitForFunction(() => window.calls.resume === 1, undefined, { timeout: 12000 })
    await page.waitForFunction(() => document.querySelectorAll('button').length > 0)
    assert.equal(await page.getByRole('button', { name: '重新查找' }).count(), 1, 'only the other missing employee remains')
    assert.equal(await page.evaluate(() => window.calls.retry), 0, 'approval resumes without user retry')
    assert.deepEqual(errors, [])
    log(`PASS ${width}x${height}: original work application, parallel missing employees and automatic approval resume`)
    await page.close()
  }
} finally {
  await browser?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
