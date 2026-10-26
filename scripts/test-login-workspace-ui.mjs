/* global window, document, fetch */
// Runs the real login and workspace with controlled IPC and no platform writes.
import assert from 'node:assert/strict';
import { log } from 'node:console';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright-core';

const origin = process.env.SEP_PREVIEW_ORIGIN ?? 'http://127.0.0.1:5184';
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
window.subscriptions=[];window.statuses=[];window.member='member-a';window.loginFails=false;window.loginCalls=0;
const pending=list=>new Promise((resolve,reject)=>list.push({resolve,reject}));
const emptyOrganization={enterprise:{id:'enterprise',name:'测试企业',logo:null},permissions:{grantVisibility:'ENTERPRISE',departmentGrantInheritance:'DIRECT_DEPARTMENT_ONLY',personalReportingSupported:false},statistics:{employeeCount:0,subscriptionCount:0,activeEmployeeCount:0,currentUserAvailableEmployeeCount:0},departments:[],members:[],employees:[],grants:[]};
const api={
 listRememberedAccounts:async()=>({accounts:[],encryptionAvailable:true,...(window.accountsFail?{error:{message:'历史账号读取失败，请联系平台管理员'}}:{})}),
 onAuthenticationRequired:callback=>{window.expireSession=callback;return()=>{window.expireSession=null}},
 login:async()=>{window.loginCalls++;return window.loginFails?{success:false,error:{code:'INVALID_CREDENTIALS',reason:'credentials',message:'账号或密码错误'}}:{success:true,data:{user:{id:window.member,name:window.member,email:'test@example.test'},enterprise:{id:'enterprise',name:'测试企业'}}};},
 logout:async()=>({success:true}),
 getSubscriptions:()=>pending(window.subscriptions),getEmployeeStatus:()=>pending(window.statuses),
 getAllTasks:async()=>({success:true,tasks:[]}),getEnterpriseOrganization:async()=>({success:true,data:emptyOrganization}),
 listNotifications:async()=>({success:true,data:{items:[],total:0,offset:0,limit:20}}),
 getUnreadNotificationCount:async()=>({success:true,data:{count:0}}),
};
window.electronAPI=new Proxy(api,{get:(target,name)=>name in target?target[name]:String(name).startsWith('on')?()=>()=>{}:async()=>({success:false,error:{message:'测试服务未启用'}})});
window.employee=name=>({subscriptionId:'sub-'+name,employeeId:'employee-'+name,name,description:'',status:'ACTIVE',allowedModels:[],template:{name:'分析师',avatar:null},templateVersion:'1'});
createRoot(document.getElementById('root')).render(React.createElement(App));
</script></body></html>`;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const [width, height] of [[1200, 800], [960, 640]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/__login-workspace-test', route => route.fulfill({ contentType: 'text/html', body: html }));
    const login = async () => {
      await page.getByLabel('邮箱', { exact: true }).fill('test@example.test');
      await page.getByLabel('密码', { exact: true }).fill('fixture-password');
      await page.getByRole('button', { name: '登录', exact: true }).click();
    };
    await page.goto(origin + '/__login-workspace-test');
    await page.getByLabel('邮箱', { exact: true }).waitFor();
    await page.evaluate(() => { window.loginFails = true; });
    await login();
    await page.getByRole('dialog').filter({ hasText: '账号或密码错误' }).waitFor();
    assert.equal(await page.locator('.ent-shell').count(), 0);
    await page.getByRole('button', { name: '知道了', exact: true }).click();
    await page.evaluate(() => { window.loginFails = false; });
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForFunction(() => window.subscriptions.length === 1 && window.statuses.length === 1);
    await page.waitForTimeout(3300);
    assert.equal(await page.locator('.ent-shell').isVisible(), true, 'slow employee requests must not block the workspace');
    assert.equal(await page.getByText('正在准备你的员工团队', { exact: true }).count(), 0);
    assert.equal(await page.getByText('暂时无法进入工作台', { exact: true }).count(), 0);
    await page.screenshot({ path: join(tmpdir(), 'sep-login-loading-' + width + '.png') });
    await page.evaluate(() => window.subscriptions[0].resolve({success:true,data:[window.employee('已加载员工')]}));
    await page.getByRole('button', { name: '硅基员工', exact: true }).click();
    await page.getByText('已加载员工', { exact: true }).first().waitFor();
    // The auxiliary status endpoint is still pending while employees are usable.
    await page.evaluate(() => window.statuses[0].resolve({success:false,error:{message:'员工状态暂时不可用'}}));
    const statusError = page.getByRole('alert').filter({ hasText: '员工状态暂时不可用' });
    await statusError.waitFor();
    await statusError.getByRole('button', { name: '重试加载员工状态' }).click();
    await page.waitForFunction(() => window.statuses.length === 2);
    await page.evaluate(() => window.statuses[1].resolve({success:true,data:[]}));
    await statusError.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.subscriptions.length), 1, 'status retry must not refetch subscriptions');
    await page.screenshot({ path: join(tmpdir(), 'sep-login-workspace-' + width + '.png') });

    await page.reload();
    await login();
    await page.waitForFunction(() => window.subscriptions.length === 1);
    await page.evaluate(() => {
      window.subscriptions[0].resolve({success:false,error:{message:'员工列表暂时不可用'}});
      window.statuses[0].resolve({success:true,data:[]});
    });
    const listError = page.getByRole('alert').filter({ hasText: '员工列表暂时不可用' });
    await listError.waitFor();
    assert.equal(await page.locator('.ent-shell').isVisible(), true);
    await page.screenshot({ path: join(tmpdir(), 'sep-login-error-' + width + '.png') });
    await listError.getByRole('button', { name: '重试加载员工列表' }).click();
    await page.waitForFunction(() => window.subscriptions.length === 2);
    await page.evaluate(() => window.subscriptions[1].resolve({success:true,data:[]}));
    await listError.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.loginCalls), 1, 'retry must reuse the authenticated session');

    // Start an old request, sign out and back in, then deliver the old result last.
    await page.reload();
    await login();
    await page.waitForFunction(() => window.subscriptions.length === 1);
    await page.evaluate(sameAccount => { window.member = sameAccount ? 'member-a' : 'member-b'; }, width === 960);
    await page.locator('.ent-side-user').click();
    await page.getByRole('menuitem', { name: '退出登录', exact: true }).click();
    await login();
    await page.waitForFunction(() => window.subscriptions.length === 2);
    await page.evaluate(() => window.subscriptions[1].resolve({success:true,data:[window.employee('新账号员工')]}));
    await page.getByRole('button', { name: '硅基员工', exact: true }).click();
    await page.getByText('新账号员工', { exact: true }).first().waitFor();
    await page.evaluate(() => {
      window.subscriptions[0].resolve({success:true,data:[window.employee('旧账号员工')]});
      window.statuses[0].resolve({success:false,error:{message:'旧账号错误'}});
    });
    await page.waitForTimeout(50);
    assert.equal(await page.getByText('旧账号员工', { exact: true }).count(), 0);
    assert.equal(await page.getByText('旧账号错误', { exact: true }).count(), 0);
    assert.equal(await page.getByText('新账号员工', { exact: true }).count() > 0, true);
    await page.evaluate(() => { window.expireSession(); window.expireSession(); });
    const expired = page.getByRole('dialog').filter({ hasText: '登录已失效，请重新登录' });
    await expired.waitFor();
    assert.equal(await page.getByRole('dialog').count(), 1);
    await page.getByRole('button', { name: '知道了', exact: true }).click();
    await expired.waitFor({ state: 'detached' });
    await page.getByLabel('邮箱', { exact: true }).waitFor();
    await login();
    assert.equal(await page.getByRole('dialog').count(), 0, 'a successful login must not show a success dialog');
    await page.locator('.ent-side-user').click();
    await page.evaluate(() => { window.accountsFail = true; });
    await page.getByRole('menuitem', { name: '退出登录', exact: true }).click();
    await page.getByRole('dialog').filter({ hasText: '历史账号读取失败，请联系平台管理员' }).waitFor();
    await page.getByRole('button', { name: '知道了', exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    assert.deepEqual(errors, []);
    log('PASS login/workspace', { width, height, checks: 'direct entry, slow requests, independent status, retry, stale session, expiry deduplication, account read error' });
    await page.close();
  }
} finally { await browser.close(); }
