/* global window, document, innerWidth, getComputedStyle */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const root = fileURLToPath(new URL('../', import.meta.url))
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ScheduledTasksPage } from './src/pages/enterprise/ScheduledTasksPage';
import { WorkDetailPage } from './src/pages/enterprise/WorkDetailPage';
import { WorkScheduleDialog } from './src/components/enterprise/scheduled/WorkScheduleDialog';
import { AppSideNav } from './src/components/enterprise/AppSideNav';
import { FeedbackProvider } from './src/components/feedback/FeedbackProvider';
import { cronPreview } from './src/shared/cron-schedule';
import './src/styles/enterprise.css';
import './src/styles/arrange.css';
import './src/styles/scheduled-tasks.css';
const data = { definitions: [], occurrences: [], creations: [], schedulerState: 'running' };
const counters = { create: 0, edit: 0, plan: 0, acknowledge: 0, check: 0, interpret: 0 };
window.testData = data; window.counters = counters;
window.creationCalls = []; window.lostResponse = false; window.workScheduleCalls = []; window.loseWorkResponse = false;
const copy = value => structuredClone(value);
const employee = { id: 'employee', name: '行业研究员', roleName: '行业研究', avatar: null, avatarAsset: null, assignedToMe: true, availability: 'ready', allowedModels: ['test-model'] };
const employees = [employee, { ...employee, id: 'employee-alt', name: '数据分析师', allowedModels: ['alternate-model'] }, { ...employee, id: 'employee-blocked', assignedToMe: false, allowedModels: ['restricted-model'] }];
const find = id => data.definitions.find(item => item.id === id);
const change = (value, mutate) => {
 const item = find(value.id);
 if (item.revision !== value.expectedRevision) return { success: false, error: { message: '配置已经变化，请刷新' } };
 mutate(item); item.revision++; return { success: true, data: copy(item) };
};
window.electronAPI = {
 async getScheduledWorkSource(taskId) { return {success: true, data: {taskId, title: '原工作标题', planHash: 'a'.repeat(64), subscriptionId: 'employee', modelId: 'test-model'}}; },
 async createScheduledTaskFromWork(request) {
  window.workScheduleCalls.push(copy(request));
  let item = find(request.requestId);
  if (!item) {
   const input = {name: request.name, goal: '复制原工作完整计划', mode: 'auto', subscriptionId: 'employee', modelId: 'test-model', workDir: 'D:/reports', timezone: request.timezone, permissions: {preset: 'workspace-edit', approvalMode: 'confirm-each'}, scheduledAt: request.scheduledAt, recurrence: request.recurrence};
   item = {id: request.requestId, revision: 1, enabled: true, deleted: false, nextRunAt: input.scheduledAt, planInputKey: 'key', createdAt: Date.now(), updatedAt: Date.now(), input,
    plan: {status: 'ready', kind: 'arrangement', title: '原工作标题', intentAnalysis: null, source: {taskId: request.taskId, templateId: 'template', planHash: 'b'.repeat(64), requestKey: 'c'.repeat(64)}, nodes: [{id: 'writer', subscriptionId: 'employee', modelId: 'test-model', title: '报告', instruction: '写报告', expectedOutput: '报告文件', deliverables: [{id:'report',name:'报告',format:'md',path:'report.md',contentOutline:['总结'],acceptanceCriteria:['可使用']}], dependsOn:[],skillIds:[],requiresUserConfirmation:false}]}};
   data.definitions.push(item);
  }
  if (window.loseWorkResponse) { window.loseWorkResponse = false; throw Error('response lost'); }
  return {success: true, data: copy(item)};
 },
 async editScheduledTaskFromWork(value) { return change(value, item => { item.input = {...item.input, name: value.name, scheduledAt: value.scheduledAt, timezone: value.timezone, recurrence: value.recurrence}; item.enabled = true; item.nextRunAt = value.scheduledAt; }); },
 async submitScheduledCreation(request) {
  window.creationCalls.push(copy(request));
  if (request.message.includes('未送达')) throw Error('unreachable');
  let item = data.creations.find(value => value.id === request.requestId);
  if (item && item.request.message === request.message && item.stage !== 'failed') { window.lostResponse = false; return {success: true, data: copy(item)}; }
  const {requestId, expectedRevision, ...input} = request;
  if (!item) {
   item = {id: requestId, revision: 1, stage: 'parsing', request: input, submissionKey: 'key', parsedSubmissionKey: null, definitionSubmissionKey: null, referenceNow: Date.now(), messages: [{role: 'user', content: input.message}], interpretation: null, definitionId: null, definitionInput: null, error: null, createdAt: Date.now(), updatedAt: Date.now()};
   data.creations.push(item);
  } else { if (expectedRevision !== item.revision) return {success: false, error: {message: '创建状态已变化'}}; item.request = input; item.messages.push({role: 'user', content: input.message}); item.revision++; }
  const needsInput = input.message.includes('问题');
  item.interpretation = {status: needsInput ? 'needs_input' : 'ready', task: {title: '自然语言报告', goal: input.message, deliverables: ['report.docx'], execution: {mode: 'employee', subscriptionId: 'employee'}, schedule: {kind: 'cron', timezone: input.timezone, expression: '0 9 * * *', localDateTime: null, description: '每天早上九点'}}, questions: needsInput ? [{field: 'schedule', question: '请问每天几点执行？'}] : [], reasons: []};
  item.stage = needsInput ? 'needs_input' : input.message.includes('保持规划') ? 'planning' : 'completed'; item.revision++;
  if (item.stage === 'completed') {
   const definition = {id: requestId, revision: 3, enabled: true, deleted: false, nextRunAt: Date.now()+86400000, planInputKey: 'key', createdAt: Date.now(), updatedAt: Date.now(), input: {name: '自然语言报告', goal: input.message, mode: 'employee', subscriptionId: 'employee', modelId: input.modelId, workDir: input.workDir, timezone: input.timezone, permissions: input.permissions, scheduledAt: cronPreview('0 9 * * *', input.timezone, Date.now(), 1)[0], recurrence: {frequency: 'cron', interval: 1, preset: 'daily', expression: '0 9 * * *', description: '每天早上九点'}}, plan: {status: 'ready', objective: '报告', instruction: '生成报告文件', expectedOutput: 'report.docx', deliverables: [{id: 'file', name: '报告', path: 'report.docx', format: 'docx', contentOutline: ['总结'], acceptanceCriteria: ['来源清晰']}]}};
   data.definitions.push(definition); item.definitionId = definition.id; item.definitionInput = copy(definition.input);
  }
  if (input.message.includes('丢失响应')) { window.lostResponse = true; throw Error('response lost'); }
  if (input.message.includes('保持规划')) { const reply = copy(item); return new Promise(resolve => { window.finishCreation = () => resolve({success: true, data: reply}); }); }
  return {success: true, data: copy(item)};
 },
 async cancelScheduledCreation(value) {
  const item = data.creations.find(item => item.id === value.id);
  if (value.expectedRevision !== item.revision) return {success: false, error: {message: '创建状态已变化'}};
  item.stage = 'cancelled'; item.revision++; return {success: true, data: copy(item)};
 },
 async interpretScheduleTime(value) { counters.interpret++; if (value.description.includes('网络失败')) throw Error('offline'); if (value.description.includes('不明确')) return {success: true, data: {status: 'blocked', reasons: ['请明确运行时间']}}; return {success: true, data: {status: 'ready', expression: '30 9 1,15,30 * *'}}; },
 async listScheduledTasks() { return { success: true, data: copy({...data, creations: window.lostResponse ? [] : data.creations}) }; },
 async createScheduledTask({requestId, input}) {
  counters.create++;
  const old = find(requestId);
  if (old) return { success: true, data: copy(old) };
  const item = { id: requestId, input, revision: 1, enabled: false, deleted: false, nextRunAt: null, plan: null, planInputKey: null, createdAt: Date.now(), updatedAt: Date.now() };
  data.definitions.push(item); return { success: true, data: copy(item) };
 },
 async editScheduledTask(value) { counters.edit++; return change(value, item => { item.input = value.input; item.enabled = false; item.nextRunAt = null; item.pausedAt = null; }); },
 async planScheduledTask(value) { counters.plan++; return change(value, item => { item.planInputKey = 'key'; item.plan = { status: 'ready', objective: '生成行业报告', instruction: '读取当前员工技能，研究并生成可用文件。', expectedOutput: '行业报告.docx', deliverables: [{id: 'report', name: '行业报告', path: 'report.docx', format: 'docx', contentOutline: ['趋势', '建议'], acceptanceCriteria: ['来源清晰', '文件可用']}] }; }); },
 async confirmScheduledTask(value) { return change(value, item => { item.enabled = true; item.nextRunAt = item.input.scheduledAt; item.pausedAt = null; }); },
 async pauseScheduledTask(value) { return change(value, item => { item.enabled = false; item.nextRunAt = null; item.pausedAt = Date.now(); }); },
 async deleteScheduledTask(value) { return change(value, item => { item.deleted = true; item.enabled = false; item.nextRunAt = null; item.pausedAt = null; }); },
 async checkScheduledRun(id) { counters.check++; data.occurrences.find(run => run.id === id).status = 'pending'; return {success: true}; },
 async acknowledgeScheduledRun(value) { counters.acknowledge++; if (value.confirmed !== true) throw Error('missing acknowledgement'); const run = data.occurrences.find(run => run.id === value.id); run.status = 'cancelled'; run.finishedAt = Date.now(); return {success: true}; },
 async cancelScheduledRun(id) { data.occurrences.find(run => run.id === id).status = 'cancelled'; return {success: true}; },
 async resumeScheduledTasks() { data.schedulerState = 'running'; return {success: true}; },
 async getDefaultWorkspaceDirectory() { return { success: true, path: null }; },
 onPiEvent() { return () => {}; },
 async listTaskRuns() { return { success: true, runs: [] }; },
 async getTaskTimeline() { return { success: true, events: [] }; },
};
window.seedRun = status => {
 const item = data.definitions[0]; item.enabled = false; item.nextRunAt = null;
 data.occurrences = [{id: 'run-' + status, definitionId: item.id, revision: item.revision, scheduledAt: item.input.scheduledAt, input: copy(item.input), plan: copy(item.plan), taskId: 'work', status,
 firstEligibleAt: Date.now(), startDeadline: Date.now()+3600000, startedAt: Date.now(), finishedAt: null, nextRetryAt: null, stopReason: null,
 error: {code: 'EXECUTION_UNCERTAIN', message: '执行中断，请核查', action: 'review'}, attempts: [{id: 'attempt', number: 1, startedAt: Date.now(), finishedAt: null, status: 'admitted', error: null}]}];
};
function App() {
 const dark = new URLSearchParams(window.location.search).has('dark');
 const [scope, setScope] = React.useState('test-user'); window.switchScope = setScope;
 const [route, setRoute] = React.useState({ name: 'scheduled' });
 window.scheduleNavigate = setRoute;
 React.useEffect(() => { if (new URLSearchParams(window.location.search).has('work-import')) window.openWorkSchedule(); }, []);
 const history = React.useRef([]);
 const navigate = next => { history.current.push(route); setRoute(next); };
 const work = {id: 'work', title: '行业周报执行结果', goal: '研究行业并生成文件', kind: 'flow', workType: {state: 'resolved', kind: 'arrangement'}, status: 'completed', progress: 100, currentEmployeeId: employee.id, currentEmployeeName: employee.name, steps: [], nextUserAction: null, createdAt: Date.now(), updatedAt: Date.now(), participants: [employee.id], deliverables: [{id: 'report', name: '行业报告.docx', path: 'D:/reports/report.docx', note: '研究成果'}], timeline: [], messages: [{id: 'message', role: 'employee', employeeId: employee.id, employeeName: employee.name, content: '报告已完成。', createdAt: Date.now()}], activities: [], sharedContext: {goal: '', confirmedInputs: [], previousResults: [], userNotes: []}, stopReason: null, workDir: 'D:/reports', scheduledOrigin: {definitionId: data.definitions[0]?.id, occurrenceId: data.occurrences[0]?.id}};
 const workspace = { route, employees, myEmployees: employees, works: [work], navigate, replaceRoute: setRoute, canGoBack: true, goBack: () => setRoute(history.current.pop()), chooseFolder: async () => 'D:/客户资料/报告成果/包含较长路径的目录/项目资料' };
 return <div className={dark ? 'ent-shell dark' : 'ent-shell'}><AppSideNav enterpriseName='示例企业' enterpriseMark='企' current={route.name} needsMeCount={0} canManage={false} userName='测试成员' collapsed={false} onToggleCollapse={() => {}} onNavigate={navigate} onOpenSettings={() => {}} onCheckUpdate={() => {}} onLogout={() => {}} /><main className='ent-shell-main'><header className='ent-topbar'>定时任务</header><div className='ent-scroll'>{route.name === 'scheduled' ? <ScheduledTasksPage workspace={workspace} scopeKey={scope} /> : <WorkDetailPage workspace={workspace} workId='work' />}</div></main></div>;
}
createRoot(document.getElementById('root')).render(<FeedbackProvider><React.StrictMode><App /></React.StrictMode></FeedbackProvider>);
const importRoot = createRoot(document.body.appendChild(document.createElement('div')));
window.openWorkSchedule = () => importRoot.render(<React.StrictMode><WorkScheduleDialog source={{id:'source-work',title:'原工作标题'}} scopeKey='test-user' onClose={() => importRoot.render(null)} onCreated={saved => { importRoot.render(null); window.scheduleNavigate({name:'scheduled',taskId:saved.id,view:'configuration'}); }} /></React.StrictMode>);
`
const bundle = await build({ stdin: { contents: fixture, loader: 'tsx', resolveDir: root }, bundle: true, write: false, outfile: 'fixture.js', format: 'iife', jsx: 'automatic', loader: { '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': JSON.stringify('development') },
  plugins: [{ name: 'scheduled-ui-asset-stubs', setup(build) {
    build.onResolve({ filter: /\?url$/ }, args => ({ path: args.path, namespace: 'scheduled-ui-asset' }))
    build.onLoad({ filter: /.*/, namespace: 'scheduled-ui-asset' }, () => ({ contents: 'export default "scheduled-ui-test-asset"', loader: 'js' }))
  } }],
})
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text
const css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text
const server = createServer((request, response) => {
  if (request.url === '/fixture.js') { response.setHeader('Content-Type', 'text/javascript; charset=utf-8'); response.end(js) }
  else if (request.url === '/fixture.css') { response.setHeader('Content-Type', 'text/css; charset=utf-8'); response.end(css) }
  else { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(`<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"><style>*,::before,::after{box-sizing:border-box}html,body,#root{height:100%;margin:0}body{font-family:'Segoe UI','Microsoft YaHei',sans-serif}button,input,textarea,select{font:inherit}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`) }
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
if (process.argv.includes('--serve')) {
  console.log(`Scheduled tasks UI preview: http://127.0.0.1:${server.address().port}`)
  await new Promise(() => {})
}
const screenshots = resolve(tmpdir(), 'sep-scheduled-module')
let browser
try {
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' })
  await mkdir(screenshots, { recursive: true })
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 620 }, { width: 1000, height: 760 }, { width: 760, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}${viewport.width === 1280 ? '/?dark' : ''}`)
    await page.evaluate(() => window.openWorkSchedule())
    const imported = page.getByRole('dialog', { name: '加入定时任务', exact: true })
    await imported.getByRole('button', {name:'创建并启用',exact:true}).waitFor()
    await page.waitForFunction(() => !document.querySelector('.ent-sch-work-modal fieldset').disabled)
    assert.equal(await imported.getByLabel('任务标题', {exact:true}).inputValue(), '原工作标题')
    assert.equal(await imported.getByLabel('重复频率', {exact:true}).inputValue(), 'once')
    const expectedTomorrow = await page.evaluate(() => { const value = new Date(); value.setDate(value.getDate()+1); const pad=n=>String(n).padStart(2,'0'); return value.getFullYear()+'-'+pad(value.getMonth()+1)+'-'+pad(value.getDate())+'T'+pad(value.getHours())+':'+pad(value.getMinutes()); })
    assert.equal(await imported.getByLabel('执行时间', {exact:true}).inputValue(), expectedTomorrow)
    assert.equal(await imported.locator('textarea').count(), 0)
    assert.equal(await imported.getByRole('combobox', {name:'模型',exact:true}).count(), 0)
    const importBounds = await imported.boundingBox()
    assert.ok(importBounds && importBounds.x >= 0 && importBounds.y >= 0 && importBounds.x+importBounds.width <= viewport.width+1 && importBounds.y+importBounds.height <= viewport.height+1)
    await page.screenshot({path:resolve(screenshots, 'work-import-'+viewport.width+'.png'),fullPage:true})
    await imported.getByLabel('任务标题', {exact:true}).fill('复制的定时报告')
    await page.evaluate(() => { window.loseWorkResponse = true })
    await imported.getByRole('button', {name:'创建并启用',exact:true}).click()
    await imported.getByRole('alert').waitFor()
    assert.equal(await imported.getByLabel('任务标题', {exact:true}).isDisabled(), true)
    await imported.getByRole('button', {name:'取消',exact:true}).click()
    await page.evaluate(() => window.openWorkSchedule())
    await imported.getByRole('button', {name:'核对并重试',exact:true}).click()
    await imported.waitFor({state:'detached'})
    assert.deepEqual(await page.evaluate(() => ({count:window.testData.definitions.length,same:JSON.stringify(window.workScheduleCalls[0])===JSON.stringify(window.workScheduleCalls[1]),plans:window.counters.plan})), {count:1,same:true,plans:0})
    await page.getByRole('button',{name:'编辑任务配置',exact:true}).click()
    const sourceEdit = page.getByRole('dialog',{name:'编辑定时任务',exact:true})
    assert.equal(await sourceEdit.locator('textarea').count(),0)
    await sourceEdit.getByLabel('任务标题',{exact:true}).fill('修改后的定时报告')
    await sourceEdit.getByRole('button',{name:'保存并启用',exact:true}).click()
    await sourceEdit.waitFor({state:'detached'})
    assert.equal(await page.evaluate(() => window.testData.definitions.length),1)
    await page.evaluate(() => { window.testData.definitions=[]; window.scheduleNavigate({name:'scheduled'}); window.switchScope('after-import') })
    await page.locator('.ent-sch-sidebar .ent-sch-nav-task').waitFor({state:'detached'})
    const openComposer = async () => {
      if (!await page.getByLabel('定时任务工作内容', { exact: true }).isVisible()) await page.getByRole('button', { name: '新建任务', exact: true }).first().click()
      await page.getByLabel('定时任务工作内容', { exact: true }).waitFor()
      assert.equal(await page.getByRole('dialog', { name: '新建定时任务', exact: true }).count(), 0)
    }
    const openManual = async () => { await openComposer(); await page.getByRole('button', { name: '手动设置', exact: true }).click() }
    await openComposer()
    assert.equal(await page.locator('.ent-sch-home-compose').count(), 1)
    assert.equal(await page.getByText('管理周期工作与下一次执行时间', { exact: true }).count(), 0)
    assert.equal(await page.getByText('还没有定时任务', { exact: true }).count(), 0)
    await page.screenshot({ path: resolve(screenshots, `workspace-empty-${viewport.width}.png`), fullPage: true })
    const homeGoal = page.getByLabel('定时任务工作内容', { exact: true })
    const checkHomeLayout = async () => {
      const pane = await page.locator('.ent-sch-main-pane').boundingBox()
      const composer = await page.locator('.ent-sch-home-compose').boundingBox()
      const content = await page.locator('.ent-sch-home-content').boundingBox()
      assert.ok(pane && composer && content)
      assert.ok(content.y + content.height <= composer.y + 1)
      assert.ok(pane.y + pane.height - composer.y - composer.height <= 29)
      assert.ok(composer.y + composer.height <= viewport.height + 1)
      await page.waitForFunction(() => {
        const image = document.querySelector('.ent-sch-clock')
        return image?.complete && image.naturalWidth === 112 && image.naturalHeight === 112
      })
      const icon = await page.locator('.ent-sch-clock').boundingBox()
      const examples = await page.getByRole('region', { name: '定时任务示例', exact: true }).boundingBox()
      assert.ok(icon && examples && examples.y >= icon.y + icon.height)
      const centers = await page.locator('.ent-sch-home-compose').locator('.ent-model-trigger, .ent-rs-directory, .ent-rs-permission, .ent-rs-approval').evaluateAll(elements => elements.map(element => {
        const box = element.getBoundingClientRect()
        return box.y + box.height / 2
      }))
      assert.equal(centers.length, 4)
      assert.ok(Math.max(...centers) - Math.min(...centers) < 2, JSON.stringify(centers))
      assert.ok(await page.locator('.ent-sch-main-pane').evaluate(element => element.scrollWidth <= element.clientWidth + 1))
    }
    await checkHomeLayout()
    const modelControl = container => container.getByRole('combobox', { name: '模型', exact: true })
    const modelValue = async container => (await modelControl(container).textContent()).trim()
    const selectModel = async (container, value) => {
      await modelControl(container).click()
      const search = page.getByRole('textbox', { name: '搜索模型', exact: true })
      await search.fill(value)
      const option = page.locator('.ent-model-options [role="option"]').filter({ hasText: value })
      await option.click({ timeout: 5000 })
      assert.equal(await modelValue(container), value)
    }
    await homeGoal.waitFor()
    const checkControls = async (container, automatic, natural = false) => {
      assert.equal(await container.getByLabel('执行员工', { exact: true }).count(), automatic || natural ? 0 : 1)
      assert.equal(await container.getByLabel('任务模式', { exact: true }).count(), natural ? 0 : 1)
      assert.equal(await container.getByLabel('规划员工', { exact: true }).count(), 0)
      const model = modelControl(container)
      assert.equal(await model.evaluate(element => element.closest('.ent-sch-execution-selects') !== null), true)
      assert.equal(await container.locator('.ent-rs-inline').evaluate(element => getComputedStyle(element).marginLeft), '0px')
      const backgrounds = await container.locator('.ent-sch-execution-selects .ent-rs-compact').evaluateAll(elements => elements.map(element => getComputedStyle(element).backgroundColor))
      assert.ok(backgrounds.every(color => color === backgrounds[0] && color !== 'rgba(0, 0, 0, 0)'), JSON.stringify(backgrounds))
      if (viewport.width > 760 && !natural) {
        const previous = await container.locator(automatic ? '.ent-sch-mode' : '.ent-sch-employee').boundingBox()
        const current = await model.boundingBox()
        assert.ok(Math.abs(current.y - previous.y) < 2 && current.x - previous.x - previous.width <= 16, JSON.stringify({ previous, current }))
      }
    }
    const checkControlFocus = async (container, automatic, natural = false) => {
      const controls = [
        ...(natural ? [] : [{ name: '任务模式', control: container.getByLabel('任务模式', { exact: true }) }]),
        ...(automatic || natural ? [] : [{ name: '执行员工', control: container.getByLabel('执行员工', { exact: true }) }]),
        { name: '模型', control: modelControl(container) },
      ]
      for (const { name, control } of controls) {
        if (await control.isDisabled()) continue
        const before = await control.evaluate(element => {
          const box = (element.closest('label') ?? element.closest('.ent-model-picker')).getBoundingClientRect()
          return { width: box.width, height: box.height }
        })
        await control.focus()
        const focused = await control.evaluate(element => {
          const label = element.closest('label') ?? element.closest('.ent-model-picker')
          const box = label.getBoundingClientRect()
          const outer = getComputedStyle(label), inner = getComputedStyle(element)
          return { width: box.width, height: box.height, outerOutline: outer.outlineStyle, outerWidth: outer.outlineWidth, innerOutline: inner.outlineStyle, innerShadow: inner.boxShadow }
        })
        assert.deepEqual({ width: focused.width, height: focused.height }, before)
        assert.equal(focused.outerOutline, 'solid', name)
        assert.equal(focused.outerWidth, '2px', name)
        assert.equal(focused.innerOutline, 'none', name)
        assert.equal(focused.innerShadow, 'none', name)
      }
    }
    await checkControls(page.locator('.ent-sch-home-compose'), true, true)
    await checkControlFocus(page.locator('.ent-sch-home-compose'), true, true)
    await page.screenshot({ path: resolve(screenshots, `controls-home-${viewport.width}.png`), fullPage: true })
    assert.equal(await page.getByRole('heading', { name: '安排任务', exact: true }).count(), 1)
    assert.equal(await page.getByRole('button', { name: '全部任务', exact: true }).count(), 0)
    assert.equal(await page.locator('.ent-scroll').evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)')
    assert.equal(await page.getByRole('region', { name: '进行中的定时任务', exact: true }).count(), 0)
    assert.equal(await page.getByRole('region', { name: '已暂停的定时任务', exact: true }).count(), 0)
    assert.equal(await page.getByRole('region', { name: '定时任务示例', exact: true }).count(), 1)
    assert.equal(await page.getByRole('button', { name: '创建并启用定时任务', exact: true }).isDisabled(), true)
    await page.getByRole('button', { name: '使用示例：行业日报', exact: true }).click()
    assert.match(await homeGoal.inputValue(), /每个工作日早上 9 点/)
    assert.equal(await homeGoal.evaluate(element => element === element.ownerDocument.activeElement), true)
    assert.equal(await modelValue(page), 'test-model')
    await modelControl(page).click()
    const homePickerBounds = await page.getByRole('dialog', { name: '选择模型', exact: true }).boundingBox()
    assert.ok(homePickerBounds && homePickerBounds.x >= 0 && homePickerBounds.y >= 0
      && homePickerBounds.x + homePickerBounds.width <= viewport.width + 1
      && homePickerBounds.y + homePickerBounds.height <= viewport.height + 1, JSON.stringify(homePickerBounds))
    await page.screenshot({ path: resolve(screenshots, `home-model-picker-${viewport.width}.png`), fullPage: true })
    assert.deepEqual(await page.locator('.ent-model-options [role="option"]').evaluateAll(options => options.map(option => option.textContent)), ['暂不选择', 'test-model', 'alternate-model'])
    await page.getByRole('option', { name: 'alternate-model', exact: true }).click()
    await page.getByRole('button', { name: '选择目录', exact: true }).click()
    await page.getByLabel('访问权限', { exact: true }).selectOption('full-local')
    await page.getByRole('checkbox', { name: '自动放行', exact: true }).check()
    await homeGoal.fill('保留我的工作要求')
    await openManual()
    const manualDraft = page.getByRole('dialog', { name: '新建定时任务', exact: true })
    await manualDraft.waitFor()
    await manualDraft.getByRole('button', { name: '取消', exact: true }).click()
    await manualDraft.waitFor({ state: 'detached' })
    await openComposer()
    assert.equal(await homeGoal.inputValue(), '保留我的工作要求')
    assert.equal(await modelValue(page), 'alternate-model')
    assert.equal(await page.getByLabel('访问权限', { exact: true }).inputValue(), 'full-local')
    assert.equal(await page.getByRole('checkbox', { name: '自动放行', exact: true }).isChecked(), true)
    assert.match(await page.locator('.ent-sch-home-compose .ent-rs-directory').textContent(), /项目资料/)
    await page.getByRole('button', { name: '使用示例：销售周报', exact: true }).click()
    await page.getByRole('alertdialog', { name: '替换当前内容？', exact: true }).waitFor()
    await page.getByRole('button', { name: '保留内容', exact: true }).click()
    assert.equal(await homeGoal.inputValue(), '保留我的工作要求')
    await page.getByRole('button', { name: '使用示例：销售周报', exact: true }).click()
    await page.getByRole('button', { name: '替换内容', exact: true }).click()
    assert.match(await homeGoal.inputValue(), /Excel 汇总表/)
    assert.equal(await page.getByLabel('访问权限', { exact: true }).inputValue(), 'full-local')
    assert.equal(await page.getByRole('checkbox', { name: '自动放行', exact: true }).isChecked(), true)
    await page.screenshot({ path: resolve(screenshots, `home-empty-${viewport.width}.png`), fullPage: true })
    await page.getByRole('button', { name: '创建并启用定时任务', exact: true }).click()
    await page.getByText('已创建并启用', { exact: true }).waitFor()
    assert.equal(await page.getByRole('dialog', { name: '新建定时任务', exact: true }).count(), 0)
    await checkHomeLayout()
    await page.waitForFunction(() => document.querySelector('#schedule-home-goal')?.value === '')
    assert.equal(await homeGoal.inputValue(), '')
    assert.equal(await page.evaluate(() => window.testData.definitions.length), 1)
    const firstRequest = await page.evaluate(() => window.creationCalls[0])
    assert.equal(firstRequest.modelId, 'alternate-model')
    assert.equal(firstRequest.workDir, 'D:/客户资料/报告成果/包含较长路径的目录/项目资料')
    assert.deepEqual(firstRequest.permissions, {preset: 'full-local', approvalMode: 'auto-approve'})
    assert.equal('mode' in firstRequest || 'subscriptionId' in firstRequest, false)
    assert.equal('knowledge' in firstRequest, false)
    await page.screenshot({ path: resolve(screenshots, `creation-completed-${viewport.width}.png`), fullPage: true })
    await page.getByRole('button', { name: '查看执行记录', exact: true }).click()
    await page.getByRole('tab', { name: '执行记录', exact: true }).waitFor()
    await page.evaluate(() => window.seedRun('completed'))
    await page.getByRole('button', { name: '返回首页', exact: true }).click()
    const history = page.getByRole('region', { name: '定时任务历史', exact: true })
    await history.waitFor()
    await history.getByRole('button').click()
    await page.getByRole('button', { name: '查看工作详情与成果', exact: true }).click()
    await page.getByRole('heading', { name: '行业周报执行结果', exact: true }).waitFor()
    await page.getByRole('button', { name: '查看产出结果', exact: true }).click()
    await page.getByText('行业报告.docx', { exact: true }).waitFor()
    await page.getByRole('button', { name: '关闭详情面板', exact: true }).click()
    await page.getByRole('button', { name: '返回', exact: true }).click()
    await page.getByRole('button', { name: '返回首页', exact: true }).click()
    await openComposer()
    await homeGoal.fill('问题：每天整理工作资料')
    await page.getByRole('button', { name: '选择目录', exact: true }).click()
    await page.getByRole('button', { name: '创建并启用定时任务', exact: true }).click()
    await page.getByText('请问每天几点执行？', { exact: true }).waitFor()
    const questionId = await page.evaluate(() => window.testData.creations[1].id)
    await page.getByRole('button', { name: '查看执行记录', exact: true }).click()
    await page.getByRole('button', { name: '返回首页', exact: true }).click()
    await page.getByRole('button', { name: '继续填写', exact: true }).click()
    await homeGoal.fill('每天早上九点')
    await page.getByRole('button', { name: '发送补充信息', exact: true }).click()
    await page.getByRole('button', { name: '发送补充信息', exact: true }).waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => window.creationCalls.at(-1).requestId), questionId)
    assert.equal(await page.evaluate(() => window.creationCalls.at(-1).expectedRevision), 2)
    assert.equal(await page.evaluate(() => window.testData.definitions.length), 2)
    await homeGoal.fill('丢失响应：每天生成一份报告')
    await page.getByRole('button', { name: '创建并启用定时任务', exact: true }).click()
    await page.getByText('发送结果未确认', { exact: true }).waitFor()
    assert.equal(await homeGoal.inputValue(), '丢失响应：每天生成一份报告')
    await page.screenshot({ path: resolve(screenshots, `creation-retry-${viewport.width}.png`), fullPage: true })
    await page.getByRole('button', { name: '查看执行记录', exact: true }).first().click()
    await page.getByRole('button', { name: '返回首页', exact: true }).click()
    await openComposer()
    await page.getByText('发送结果未确认', { exact: true }).waitFor()
    await page.getByRole('button', { name: '重试同一请求', exact: true }).click()
    await page.getByText('发送结果未确认', { exact: true }).waitFor({ state: 'detached' })
    await page.waitForFunction(() => document.querySelector('#schedule-home-goal')?.value === '')
    assert.equal(await homeGoal.inputValue(), '')
    assert.deepEqual(await page.evaluate(() => window.creationCalls.at(-1)), await page.evaluate(() => window.creationCalls.at(-2)))
    assert.equal(await page.evaluate(() => window.testData.definitions.length), 3)
    await homeGoal.fill('保持规划：每天整理资料')
    await page.locator('.ent-sch-home-compose .ent-rs-directory').click()
    await page.getByRole('button', { name: '创建并启用定时任务', exact: true }).click()
    await page.getByText('正在生成工作计划', { exact: true }).waitFor()
    await page.screenshot({ path: resolve(screenshots, `creation-planning-${viewport.width}.png`), fullPage: true })
    await page.getByRole('button', { name: '取消创建', exact: true }).click()
    await page.getByText('已取消创建', { exact: true }).waitFor()
    await page.evaluate(() => window.finishCreation())
    await page.waitForTimeout(100)
    assert.equal(await page.getByText('已取消创建', { exact: true }).count(), 1)
    assert.equal(await page.evaluate(() => window.testData.definitions.length), 3)
    await homeGoal.fill('未送达的前用户私密任务')
    await page.getByRole('button', { name: '创建并启用定时任务', exact: true }).click()
    await page.getByText('发送结果未确认', { exact: true }).waitFor()
    await page.evaluate(() => { window.testData.creations = []; window.testData.definitions = []; window.testData.occurrences = []; window.switchScope('another-user') })
    await page.getByText('发送结果未确认', { exact: true }).waitFor({ state: 'detached' })
    assert.equal(await page.getByText('未送达的前用户私密任务', { exact: true }).count(), 0)
    await page.evaluate(() => { window.testData.creations = []; window.testData.definitions = []; window.testData.occurrences = []; window.creationCalls = [] })
    await page.reload()
    await openManual()
    const dialog = page.getByRole('dialog', { name: '新建定时任务', exact: true })
    await dialog.waitFor()
    assert.equal(await dialog.getByLabel('工作目标', { exact: true }).inputValue(), '')
    assert.equal(await dialog.getByLabel('任务名称', { exact: true }).evaluate(element => element === element.ownerDocument.activeElement), true)
    await dialog.getByLabel('任务名称', { exact: true }).fill('行业周报')
    await dialog.getByLabel('工作目标', { exact: true }).fill('研究智能行李箱行业并生成报告文件')
    await dialog.getByLabel('执行员工', { exact: true }).selectOption('employee')
    await checkControls(dialog, false)
    await checkControlFocus(dialog, false)
    await page.screenshot({ path: resolve(screenshots, `controls-editor-${viewport.width}.png`), fullPage: true })
    await dialog.getByRole('button', { name: '选择目录', exact: true }).click()
    await page.getByLabel('重复频率').selectOption('hourly')
    await page.getByLabel('每小时的分钟').fill('15')
    await page.getByLabel('预计执行时间').waitFor()
    await page.screenshot({ path: resolve(screenshots, `editor-${viewport.width}.png`), fullPage: true })
    const bounds = await dialog.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth, top: element.getBoundingClientRect().top, bottom: element.getBoundingClientRect().bottom }))
    assert.ok(bounds.scrollWidth <= bounds.width + 1 && bounds.top >= 0 && bounds.bottom <= viewport.height, JSON.stringify(bounds))
    await page.getByLabel('重复频率').selectOption('weekly')
    for (const day of ['周二', '周三', '周四']) await page.getByRole('checkbox', { name: day, exact: true }).uncheck()
    await page.getByLabel('运行时间', { exact: true }).fill('09:30')
    await page.screenshot({ path: resolve(screenshots, `weekly-${viewport.width}.png`), fullPage: true })
    await page.getByLabel('重复频率').selectOption('custom')
    await page.getByRole('dialog', { name: '自定义时间', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await page.getByRole('dialog', { name: '自定义时间', exact: true }).waitFor({ state: 'detached' })
    assert.equal(await dialog.isVisible(), true)
    await page.getByLabel('重复频率').selectOption('custom')
    await page.getByRole('dialog', { name: '自定义时间', exact: true }).waitFor()
    await page.getByLabel('自定义时间描述').fill('运行时间不明确')
    await page.getByRole('button', { name: '解析时间', exact: true }).click()
    await page.getByText('请明确运行时间', { exact: true }).waitFor()
    await page.getByLabel('自定义时间描述').fill('网络失败')
    await page.getByRole('button', { name: '解析时间', exact: true }).click()
    await page.getByText('时间解析未完成。请检查登录、模型授权和网络后重试，输入内容已保留。', { exact: true }).waitFor()
    await page.getByLabel('自定义时间描述').fill('每个月的第1、15、30号早上九点半')
    await page.getByRole('button', { name: '解析时间', exact: true }).click()
    await page.getByRole('button', { name: '确认时间', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.counters.create), 0)
    await page.screenshot({ path: resolve(screenshots, `custom-${viewport.width}.png`), fullPage: true })
    await page.getByRole('button', { name: '确认时间', exact: true }).click()
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await page.getByRole('button', { name: '生成工作计划', exact: true }).click()
    await page.getByLabel('只读工作计划').waitFor()
    assert.equal(await page.getByLabel('只读工作计划').locator('textarea,input,[contenteditable]').count(), 0)
    await page.getByRole('button', { name: '确认计划并启用', exact: true }).click()
    await page.getByText('已启用', { exact: true }).waitFor()
    await page.getByRole('button', { name: '返回首页', exact: true }).click()
    await page.getByRole('region', { name: '进行中的定时任务', exact: true }).waitFor()
    assert.equal(await page.getByRole('region', { name: '已暂停的定时任务', exact: true }).count(), 0)
    await page.screenshot({ path: resolve(screenshots, `home-active-${viewport.width}.png`), fullPage: true })
    await page.locator('.ent-sch-nav-task').click()
    await page.getByRole('tab', { name: '任务配置', exact: true }).click()
    await page.getByRole('button', { name: '暂停后续调度', exact: true }).click()
    await page.getByRole('button', { name: '返回首页', exact: true }).click()
    await page.getByRole('region', { name: '已暂停的定时任务', exact: true }).waitFor()
    assert.equal(await page.getByRole('region', { name: '进行中的定时任务', exact: true }).count(), 0)
    await page.screenshot({ path: resolve(screenshots, `home-paused-${viewport.width}.png`), fullPage: true })
    await page.locator('.ent-sch-nav-task').click()
    await page.getByRole('tab', { name: '任务配置', exact: true }).click()
    await page.getByRole('button', { name: '编辑任务配置', exact: true }).click()
    await page.getByLabel('任务名称', { exact: true }).fill('新的行业周报')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await page.getByRole('button', { name: '确认计划并启用', exact: true }).waitFor()
    assert.deepEqual(await page.evaluate(() => ({ count: window.testData.definitions.length, ...window.counters })), { count: 1, create: 1, edit: 1, plan: 1, acknowledge: 0, check: 0, interpret: 3 })
    assert.equal(await page.evaluate(() => window.testData.definitions[0].input.recurrence.expression), '30 9 1,15,30 * *')
    await page.evaluate(() => window.seedRun('review'))
    await page.getByRole('button', { name: '返回首页', exact: true }).click()
    await page.getByRole('region', { name: '进行中的定时任务', exact: true }).waitFor()
    await page.locator('.ent-sch-nav-task').click()
    await page.getByRole('button', { name: '核查后关闭本次执行', exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: '重新检查执行条件', exact: true }).count(), 0)
    await page.getByRole('button', { name: '核查后关闭本次执行', exact: true }).click()
    assert.equal(await page.evaluate(() => window.counters.acknowledge), 0)
    await page.getByRole('button', { name: '已核查，关闭记录', exact: true }).click()
    await page.getByRole('button', { name: '核查后关闭本次执行', exact: true }).waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => window.counters.acknowledge), 1)
    await page.locator('.ent-sch-main-pane').evaluate(element => { element.scrollTop = 0 })
    await page.screenshot({ path: resolve(screenshots, `history-${viewport.width}.png`), fullPage: true })
    const overflows = await page.locator('.ent-scheduled').evaluate(element => {
      const box = element.getBoundingClientRect()
      return { horizontal: element.scrollWidth - element.clientWidth, right: box.right, viewport: innerWidth }
    })
    assert.ok(overflows.horizontal <= 1, JSON.stringify(overflows))
    assert.ok(overflows.right <= viewport.width + 1, JSON.stringify(overflows))
    await page.getByRole('button', { name: '返回首页', exact: true }).click()
    await openManual()
    const automatic = page.getByRole('dialog', { name: '新建定时任务', exact: true })
    await automatic.getByLabel('任务模式', { exact: true }).selectOption('auto')
    await checkControls(automatic, true)
    await modelControl(automatic).click()
    const modelSearch = automatic.getByRole('textbox', { name: '搜索模型', exact: true })
    await modelSearch.fill('alternate')
    assert.equal(await modelSearch.evaluate(element => element === element.ownerDocument.activeElement), true)
    const pickerBounds = await automatic.getByRole('dialog', { name: '选择模型', exact: true }).boundingBox()
    assert.ok(pickerBounds && pickerBounds.x >= 0 && pickerBounds.y >= 0
      && pickerBounds.x + pickerBounds.width <= viewport.width + 1
      && pickerBounds.y + pickerBounds.height <= viewport.height + 1, JSON.stringify(pickerBounds))
    await page.screenshot({ path: resolve(screenshots, `model-picker-${viewport.width}.png`), fullPage: true })
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    assert.equal(await modelValue(automatic), 'alternate-model')
    await modelControl(automatic).click()
    await page.keyboard.press('Escape')
    assert.equal(await automatic.isVisible(), true)
    assert.equal(await modelControl(automatic).getAttribute('aria-expanded'), 'false')
    await selectModel(automatic, 'alternate-model')
    await automatic.getByLabel('任务名称', { exact: true }).fill('自动编排验证')
    await automatic.getByLabel('工作目标', { exact: true }).fill('完成研究并输出报告文件')
    await automatic.getByRole('button', { name: '选择目录', exact: true }).click()
    await page.screenshot({ path: resolve(screenshots, `editor-auto-${viewport.width}.png`), fullPage: true })
    await automatic.getByRole('button', { name: '保存', exact: true }).click()
    await automatic.waitFor({ state: 'detached' })
    assert.deepEqual(await page.evaluate(() => {
      const input = window.testData.definitions[1].input
      return { mode: input.mode, subscriptionId: input.subscriptionId, modelId: input.modelId, planCount: window.counters.plan }
    }), { mode: 'auto', subscriptionId: 'employee-alt', modelId: 'alternate-model', planCount: 1 })
    await page.evaluate(() => { window.testData.schedulerState = 'error' })
    await page.getByRole('button', { name: '返回首页', exact: true }).click()
    await page.getByRole('button', { name: '恢复调度', exact: true }).click()
    await page.getByRole('button', { name: '恢复调度', exact: true }).waitFor({ state: 'detached' })
    const pendingDrafts = page.getByRole('region', { name: '待完成的定时任务', exact: true })
    await pendingDrafts.getByRole('button', { name: /自动编排验证/ }).click()
    const resumedDraft = page.getByRole('dialog', { name: '编辑定时任务', exact: true })
    await resumedDraft.waitFor()
    assert.equal(await resumedDraft.getByLabel('工作目标', { exact: true }).inputValue(), '完成研究并输出报告文件')
    await resumedDraft.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: '返回首页', exact: true }).click()
    await page.evaluate(() => {
      const original = window.testData.definitions[0]
      window.testData.definitions = Array.from({ length: 16 }, (_, index) => ({ ...structuredClone(original), id: 'many-' + index, enabled: true, pausedAt: null, nextRunAt: Date.now() + 86400000, input: { ...original.input, name: index === 0 ? 'LongTitleWithoutSpaces'.repeat(7) : '定期行业研究任务 ' + (index + 1) } }))
      window.testData.definitions.push({ ...structuredClone(original), id: 'paused', enabled: false, pausedAt: Date.now(), nextRunAt: null })
    })
    await page.locator('.ent-sch-nav-task').nth(16).waitFor({ state: 'attached' })
    const taskCount = await page.locator('.ent-sch-nav-task').count()
    assert.equal(await page.locator('.ent-sch-home-compose').count(), 1)
    await checkHomeLayout()
    const composerBeforeScroll = await page.locator('.ent-sch-home-compose').boundingBox()
    const beforeScroll = await page.locator('.ent-sch-main-pane').boundingBox()
    await page.getByLabel('定时任务概览', { exact: true }).evaluate(element => { element.scrollTop = element.scrollHeight })
    const afterScroll = await page.locator('.ent-sch-main-pane').boundingBox()
    assert.equal(beforeScroll.y, afterScroll.y)
    assert.ok(afterScroll.y + afterScroll.height <= viewport.height + 1)
    const homeBounds = await page.locator('.ent-sch-home-page').evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth, bottom: element.getBoundingClientRect().bottom }))
    assert.ok(homeBounds.scrollWidth <= homeBounds.width + 1 && homeBounds.bottom <= viewport.height + 1, JSON.stringify(homeBounds))
    assert.ok(await page.getByLabel('定时任务概览', { exact: true }).evaluate(element => element.scrollTop > 0))
    await page.getByLabel('定时任务创建区', { exact: true }).evaluate(element => { element.scrollTop = element.scrollHeight })
    const composerAfterScroll = await page.locator('.ent-sch-home-compose').boundingBox()
    assert.deepEqual(composerAfterScroll, composerBeforeScroll)
    await page.getByRole('button', { name: '搜索定时任务', exact: true }).click()
    await page.getByRole('searchbox', { name: '搜索任务名称或内容', exact: true }).fill('LongTitleWithoutSpaces')
    assert.equal(await page.locator('.ent-sch-nav-task').count(), 1)
    await page.locator('.ent-sch-nav-task').click()
    await page.getByRole('tab', { name: '执行记录', exact: true }).waitFor()
    assert.equal(await page.locator('.ent-sch-nav-task[aria-current="page"]').count(), 1)
    assert.ok(await page.locator('.ent-sch-main-pane').evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Long task title overflows detail pane')
    await page.getByRole('searchbox', { name: '搜索任务名称或内容', exact: true }).fill('不存在的任务名称')
    await page.getByText('没有匹配的任务', { exact: true }).waitFor()
    await page.getByRole('button', { name: '搜索定时任务', exact: true }).click()
    assert.equal(await page.getByRole('searchbox', { name: '搜索任务名称或内容', exact: true }).count(), 0)
    assert.equal(await page.locator('.ent-sch-nav-task').count(), taskCount)
    const paused = page.locator('.ent-sch-nav-fold').filter({ hasText: '已暂停' })
    await paused.locator('summary').click()
    assert.equal(await paused.getByRole('region', { name: '已暂停的定时任务', exact: true }).isVisible(), false)
    await paused.locator('summary').click()
    assert.equal(await paused.getByRole('region', { name: '已暂停的定时任务', exact: true }).isVisible(), true)
    await page.screenshot({ path: resolve(screenshots, `home-scroll-${viewport.width}.png`), fullPage: true })
    await page.evaluate(() => window.scheduleNavigate({ name: 'scheduled', taskId: 'missing' }))
    await page.getByRole('status').filter({ hasText: '未找到这项任务' }).waitFor()
    await page.getByRole('button', { name: '返回首页', exact: true }).click()
    await page.getByRole('button', { name: '新建任务', exact: true }).last().waitFor()
    assert.deepEqual(errors, [])
    await page.close()
  }
  console.log(`Scheduled module UI smoke passed; screenshots: ${screenshots}`)
} finally { await browser?.close(); await new Promise(done => server.close(done)) }
