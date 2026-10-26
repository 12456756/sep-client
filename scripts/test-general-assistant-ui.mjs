/* global window, document, fetch */
// Real renderer with controlled IPC; never contacts a paid model gateway.
import assert from 'node:assert/strict';
import { log } from 'node:console';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright-core';

const origin = process.env.SEP_PREVIEW_ORIGIN ?? 'http://127.0.0.1:5186';
const main = await (await fetch(origin + '/main.tsx')).text();
const reactUrl = main.match(/from "([^"]*react\.js[^"]*)"/)[1];
const domUrl = main.match(/from "([^"]*react-dom_client[^"]*)"/)[1];
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
await import('/index.css');
const React=(await import('${reactUrl}')).default;
const {createRoot}=(await import('${domUrl}')).default;
const {default:App}=await import('/App.tsx');
window.drafts=[];window.started=[];window.preflights=[];
const employee=(name,models)=>({subscriptionId:'sub-'+name,employeeId:'employee-'+name,name,description:'分析与业务协助',status:'ACTIVE',allowedModels:models,template:{name:'分析师',avatar:null},templateVersion:'1'});
const employees=[employee('分析员工A',['private-a','common']),employee('分析员工B',['common','private-b'])];
const organization={enterprise:{id:'enterprise',name:'测试企业',logo:null},permissions:{grantVisibility:'ENTERPRISE',departmentGrantInheritance:'DIRECT_DEPARTMENT_ONLY',personalReportingSupported:false},statistics:{employeeCount:2,subscriptionCount:2,activeEmployeeCount:2,currentUserAvailableEmployeeCount:2},departments:[],members:[],employees:[],grants:[]};
const api={
 listRememberedAccounts:async()=>({accounts:[],encryptionAvailable:true}),
 login:async()=>({success:true,data:{user:{id:'member',name:'测试用户',email:'test@example.test'},enterprise:{id:'enterprise',name:'测试企业'}}}),
 getSubscriptions:async()=>({success:true,data:employees}),getEmployeeStatus:async()=>({success:true,data:[]}),
 getAllTasks:async()=>({success:true,tasks:[]}),getEnterpriseOrganization:async()=>({success:true,data:organization}),
 listNotifications:async()=>({success:true,data:{items:[],total:0,offset:0,limit:20}}),getUnreadNotificationCount:async()=>({success:true,data:{count:0}}),
 beginAttachmentImport:async()=>({success:true,data:{schemaVersion:1,sessionId:'attachment-session',owner:{memberId:'member',enterpriseId:'enterprise'},target:{kind:'compose',composerId:'test'},status:'open',createdAt:1,expiresAt:9999999999999,attachments:[],revision:0}}),
 bindAttachmentPaste:()=>()=>{},onAttachmentPaste:()=>()=>{},
 createArrangementDraft:async value=>{window.drafts.push(value);return {success:true,draft:{...value,id:'draft-general',revision:1}};},
 preflightArrangementDraft:async value=>{window.preflights.push(value);return {success:true,preflight:{canStart:true,blockingIssues:[]}};},
 confirmAndStartArrangement:async value=>{window.started.push(value);return {success:true,execution:{id:'conversation-general'}};},
};
window.electronAPI=new Proxy(api,{get:(target,name)=>name in target?target[name]:String(name).startsWith('on')?()=>()=>{}:async()=>({success:false,error:{message:'测试服务未启用'}})});
createRoot(document.getElementById('root')).render(React.createElement(App));
</script></body></html>`;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const [width, height] of [[1200, 800], [960, 640]]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(15000);
    await page.route('**/__general-assistant-test', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto(origin + '/__general-assistant-test');
    await page.getByLabel('邮箱', { exact: true }).fill('test@example.test');
    await page.getByLabel('密码', { exact: true }).fill('fixture-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('button', { name: '安排工作', exact: true }).click();
    const picker = page.locator('.ent-chat-whobtn');
    await picker.getByText('通用助手', { exact: true }).waitFor();
    assert.deepEqual(await page.getByLabel('模型', { exact: true }).locator('option').allTextContents(), ['common']);
    await picker.click();
    assert.equal(await page.getByRole('listbox', { name: '选择员工' }).getByRole('option').count(), 3);
    await page.getByRole('option', { name: /分析员工A/ }).click();
    await picker.getByText('分析员工A', { exact: true }).waitFor();
    await picker.click();
    await page.getByRole('option', { name: /通用助手/ }).click();
    assert.equal(await page.getByLabel('模型', { exact: true }).inputValue(), 'common');
    await page.screenshot({ path: join(tmpdir(), 'sep-general-assistant-' + width + '.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    await page.getByRole('tab', { name: '编排', exact: true }).click();
    assert.equal(await page.getByText('通用助手', { exact: true }).count(), 0);
    await page.getByRole('tab', { name: '手动', exact: true }).click();
    await page.getByRole('button', { name: '添加员工', exact: true }).click();
    assert.equal(await page.locator('.ent-mn-pick button').count(), 2);
    assert.equal(await page.getByText('通用助手', { exact: true }).count(), 0);
    await page.getByRole('tab', { name: '会话', exact: true }).click();
    await picker.getByText('通用助手', { exact: true }).waitFor();
    await page.getByLabel('工作目标', { exact: true }).fill('请帮我解释一下今天的工作安排');
    await page.getByRole('button', { name: '开始工作', exact: true }).click();
    await page.waitForFunction(() => window.started.length === 1);
    const submitted = await page.evaluate(() => ({ draft: window.drafts[0], checks: window.preflights.length, starts: window.started.length }));
    assert.equal(submitted.draft.mode, 'conversation');
    assert.deepEqual(submitted.draft.conversation, { kind: 'general', modelId: 'common', participants: [], activeSubscriptionId: null });
    assert.deepEqual(submitted.draft.nodes, []);
    assert.deepEqual(submitted.draft.sharedSkillIds, []);
    assert.equal(submitted.checks, 1);
    assert.equal(submitted.starts, 1);
    assert.deepEqual(errors, []);
    log('PASS general assistant UI', { width, height, checks: 'default, model intersection, employee selection, orchestration isolation, general draft submission' });
    await page.close();
  }
} finally { await browser.close(); }
