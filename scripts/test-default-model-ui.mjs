/* global window, fetch, Storage */
import assert from 'node:assert/strict';
import { log } from 'node:console';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright-core';

const origin = process.env.SEP_PREVIEW_ORIGIN ?? 'http://127.0.0.1:5191';
const main = await (await fetch(origin + '/main.tsx')).text();
const reactUrl = main.match(/from "([^"]*react\.js[^"]*)"/)[1];
const domUrl = main.match(/from "([^"]*react-dom_client[^"]*)"/)[1];
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
await import('/index.css');
const React=(await import('${reactUrl}')).default;
const {createRoot}=(await import('${domUrl}')).default;
const {ClientAppPage}=await import('/pages/ClientAppPage.tsx');
const employee=(name,models)=>({subscriptionId:'sub-'+name,employeeId:'employee-'+name,name,description:'业务协助',status:'ACTIVE',allowedModels:models,template:{name:'分析师',avatar:null},templateVersion:'1'});
let props={userId:'member',userName:'测试用户',enterpriseId:'enterprise',enterpriseName:'测试企业',instances:[employee('员工A',['first','gpt','private-a']),employee('员工B',['first','gpt','private-b'])],employeeStatuses:[],onLogout:()=>{}};
window.requests=[];window.plans=[];window.listeners=[];
const api={
 getAllTasks:async()=>({success:true,tasks:[]}),getEnterpriseOrganization:async()=>({success:false}),
 getClientProfile:async()=>({success:true,data:{user:{id:'member',name:'测试用户',email:'test@example.test',avatar:null,role:'MEMBER'},enterprise:{id:'enterprise',name:'测试企业',logo:null}}}),
 getSpeechPermission:async()=>({success:true,data:{permission:'denied'}}),
 listNotifications:async()=>({success:true,data:{items:[],total:0,offset:0,limit:20}}),getUnreadNotificationCount:async()=>({success:true,data:{count:0}}),
 beginAttachmentImport:async()=>({success:true,data:{schemaVersion:1,sessionId:'attachment-session',owner:{memberId:'member',enterpriseId:'enterprise'},target:{kind:'compose',composerId:'fixture'},status:'open',createdAt:1,expiresAt:9999999999999,attachments:[],revision:0}}),
 bindAttachmentPaste:()=>()=>{},onAttachmentPaste:()=>()=>{},
 createArrangementDraft:async value=>{window.requests.push(value);window.fixtureDraft={...value,id:'draft',revision:1,status:'draft'};return {success:true,draft:window.fixtureDraft};},
 getArrangementDraft:async()=>({success:true,draft:window.fixtureDraft}),
 planArrangementDraft:async value=>{window.plans.push(value);return {success:true,planningId:'planning'};},
 onArrangementPlanningEvent:listener=>{window.listeners.push(listener);return ()=>{window.listeners=window.listeners.filter(item=>item!==listener)}},
 preflightArrangementDraft:async()=>({success:true,preflight:{canStart:true,blockingIssues:[]}}),
 confirmAndStartArrangement:async()=>({success:false,error:{message:'fixture: no execution'}}),
 cancelArrangementPlanning:async()=>({success:true,cancelled:true}),
};
window.electronAPI=new Proxy(api,{get:(target,name)=>name in target?target[name]:String(name).startsWith('on')?()=>()=>{}:async()=>({success:false})});
const root=createRoot(document.getElementById('root'));
const render=()=>root.render(React.createElement(ClientAppPage,props));
window.updateFixture=patch=>{props={...props,...patch};render()};
window.reorderModels=()=>{props={...props,instances:props.instances.map(item=>({...item,allowedModels:[...item.allowedModels].reverse()}))};render()};
window.revokeDefault=()=>{props={...props,instances:props.instances.map(item=>({...item,allowedModels:['first']}))};render()};
window.completePlanning=()=>{
 window.fixtureDraft={...window.fixtureDraft,status:'ready',revision:2,nodes:[{id:'node',subscriptionId:'sub-员工A',modelId:'gpt',title:'分析',instruction:'分析需求',expectedOutput:'报告',dependsOn:[],skillIds:[],requiresUserConfirmation:false}]};
 for(const type of ['arrangement_plan_ready','arrangement_planning_completed'])for(const listener of window.listeners)listener({planningId:'planning',draftId:'draft',draftRevision:2,type,occurredAt:Date.now(),data:{planSummary:'分析需求',planSteps:[{id:'node',title:'分析'}]}});
};
render();
</script></body></html>`;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const [width, height] of [[1200, 850], [960, 640], [390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(15000);
    await page.route('**/__default-model-test', route => route.fulfill({ contentType: 'text/html', body: html }));
    const openSettings = async () => {
      await page.getByRole('button', { name: '测试用户，打开账号菜单' }).click();
      await page.getByRole('menuitem', { name: '设置', exact: true }).click();
      await page.getByLabel('默认模型', { exact: true }).waitFor();
    };
    const closeSettings = () => page.getByRole('button', { name: '关闭资料设置' }).click();
    const work = () => page.getByRole('button', { name: '工作', exact: true }).click();
    const model = () => page.getByLabel('模型', { exact: true });
    await page.goto(origin + '/__default-model-test');
    await openSettings();
    assert.equal(await page.getByLabel('默认模型', { exact: true }).inputValue(), '');
    await page.getByLabel('默认模型', { exact: true }).selectOption('gpt');
    await closeSettings();
    await page.reload();
    await openSettings();
    assert.equal(await page.getByLabel('默认模型', { exact: true }).inputValue(), 'gpt');
    const setting = page.getByLabel('默认模型', { exact: true });
    const bounds = await setting.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
    await page.screenshot({ path: join(tmpdir(), 'sep-default-model-settings-' + width + '.png') });
    await closeSettings();
    await work();
    assert.equal(await model().inputValue(), 'gpt');
    await model().selectOption('first');
    await page.evaluate(() => window.reorderModels());
    assert.equal(await model().inputValue(), 'first', 'catalog refresh must preserve an explicit choice');
    await openSettings();
    assert.equal(await page.getByLabel('默认模型', { exact: true }).inputValue(), 'gpt', 'task choices must not overwrite the preference');
    await page.getByLabel('默认模型', { exact: true }).selectOption('first');
    await closeSettings();
    assert.equal(await model().inputValue(), 'first');
    await page.getByRole('tab', { name: '编排', exact: true }).click();
    assert.equal(await model().inputValue(), 'first');
    await openSettings();
    await page.getByLabel('默认模型', { exact: true }).selectOption('gpt');
    await closeSettings();
    assert.equal(await model().inputValue(), 'first', 'changing preferences must not change an existing composer');
    await page.getByRole('tab', { name: '会话', exact: true }).click();
    assert.equal(await model().inputValue(), 'gpt', 'a new scene should use the latest default');
    await page.locator('.ent-chat-whobtn').click();
    await page.getByRole('option', { name: /员工A/ }).click();
    assert.deepEqual((await model().locator('option').allTextContents()).sort(), ['first', 'gpt', 'private-a'].sort());
    assert.equal(await model().inputValue(), 'gpt');
    await model().selectOption('private-a');
    await page.getByRole('textbox', { name: '工作目标', exact: true }).fill('测试默认模型');
    await page.getByRole('button', { name: '开始工作', exact: true }).click();
    await page.waitForFunction(() => window.requests.length === 1);
    assert.equal(await page.evaluate(() => window.requests[0].conversation.participants[0].modelId), 'private-a');
    await page.reload();
    await work();
    await page.getByRole('tab', { name: '编排', exact: true }).click();
    assert.equal(await model().inputValue(), 'gpt');
    await page.getByRole('textbox', { name: '工作目标', exact: true }).fill('测试默认模型编排');
    await page.getByRole('button', { name: '开始自动编排', exact: true }).click();
    await page.waitForFunction(() => window.plans.length === 1);
    assert.equal(await page.evaluate(() => window.plans[0].modelId), 'gpt');
    await openSettings();
    await page.getByLabel('默认模型', { exact: true }).selectOption('first');
    await closeSettings();
    await page.evaluate(() => window.completePlanning());
    await page.getByRole('button', { name: '执行设置', exact: true }).click();
    assert.equal(await model().inputValue(), 'gpt', 'an existing plan must retain its committed model');
    await openSettings();
    await page.getByLabel('默认模型', { exact: true }).selectOption('gpt');
    await closeSettings();
    await page.evaluate(() => window.revokeDefault());
    assert.equal(await page.locator('.ent-rs-model').getAttribute('title'), 'gpt', 'catalog changes must not silently rewrite an existing plan');
    await openSettings();
    assert.equal(await page.getByLabel('默认模型', { exact: true }).inputValue(), 'gpt');
    assert.match(await page.getByLabel('默认模型', { exact: true }).locator('option:checked').textContent(), /当前不可用/);
    await closeSettings();
    await page.getByRole('tab', { name: '会话', exact: true }).click();
    assert.equal(await model().inputValue(), 'first');
    await page.evaluate(() => window.updateFixture({ userId: 'other-member' }));
    await openSettings();
    assert.equal(await page.getByLabel('默认模型', { exact: true }).inputValue(), '');
    await closeSettings();
    await page.evaluate(() => window.updateFixture({ userId: 'member' }));
    await openSettings();
    assert.equal(await page.getByLabel('默认模型', { exact: true }).inputValue(), 'gpt');
    await page.evaluate(() => { window.originalSetItem = Storage.prototype.setItem; Storage.prototype.setItem = () => { throw new Error('denied'); }; });
    await page.getByLabel('默认模型', { exact: true }).selectOption('first');
    await page.getByRole('alert').filter({ hasText: '默认模型保存失败' }).waitFor();
    assert.equal(await page.getByLabel('默认模型', { exact: true }).inputValue(), 'gpt');
    await page.evaluate(() => { Storage.prototype.setItem = window.originalSetItem; });
    await page.getByLabel('默认模型', { exact: true }).selectOption('');
    await closeSettings();
    await page.reload();
    await openSettings();
    assert.equal(await page.getByLabel('默认模型', { exact: true }).inputValue(), '');
    await closeSettings();
    await page.evaluate(() => window.updateFixture({ canManage: true }));
    await openSettings();
    await page.getByRole('button', { name: '更换 Logo', exact: true }).waitFor();
    const dialog = await page.getByRole('dialog').boundingBox();
    assert.ok(dialog.y >= 0 && dialog.y + dialog.height <= height, 'administrator settings must fit the viewport');
    await page.screenshot({ path: join(tmpdir(), 'sep-default-model-admin-settings-' + width + '.png') });
    assert.deepEqual(errors, []);
    log('PASS default model UI', { width, height, checks: 'persistence, scoped authorization, refresh, task isolation, IPC submissions, identity, storage denial, reset' });
    await page.close();
  }
} finally { await browser.close(); }
