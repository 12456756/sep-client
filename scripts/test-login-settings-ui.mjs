/* global window, fetch */
// Isolated component fixtures only; never install fixture credentials in the app profile.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { log } from 'node:console';
import { chromium } from 'playwright-core';
const origin = process.env.SEP_PREVIEW_ORIGIN ?? 'http://127.0.0.1:5174';
const main = await (await fetch(origin + '/main.tsx')).text();
const reactUrl = main.match(/from "([^"]+\/react\.js[^"]*)"/)[1];
const domUrl = main.match(/from "([^"]+\/react-dom_client\.js[^"]*)"/)[1];
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
await import('/index.css'); await import('/styles/enterprise.css'); await import('/styles/arrange.css');
const React = (await import('${reactUrl}')).default;
const {createRoot} = (await import('${domUrl}')).default;
const {LoginPage} = await import('/pages/LoginPage.tsx');
const {ArrangeWorkPage} = await import('/pages/enterprise/ArrangeWorkPage.tsx');
window.calls = []; window.deleteFails = false;
window.electronAPI = {
  forgetAccount: async email => { if (window.deleteFails) throw new Error('fixture'); return {success:true}; },
  revealRememberedPassword: async () => { if (window.revealDelayed) await new Promise(resolve => { window.finishReveal = resolve; }); return {password: 'fixture-password'}; },
  login: async input => { window.calls.push(input); return {success:false,error:{code:'INVALID_CREDENTIALS'}}; },
};
const account = email => ({email,displayName:email,lastLoginAt:1,hasSavedPassword:true});
const root = createRoot(document.getElementById('root'));
function LoginFixture() {
 const [accounts, setAccounts] = React.useState([account('one@example.test'),account('two@example.test')]);
 return React.createElement(LoginPage,{encryptionAvailable:true,rememberedAccounts:accounts,onAccountListChange:setAccounts,onLoginSuccess:()=>{}});
}
const employee = {id:'employee-a',name:'员工甲',mark:'甲',availability:'ready',assignedToMe:true,intro:'测试职责',goodAt:[],cannotDo:[],lastWorkedAt:null,allowedModels:['model-a','model-b'],skillIds:[],permissions:[],roleName:'',department:null};
window.showChat = () => root.render(React.createElement('div',{className:'ent-shell',style:{display:'block',padding:24}},React.createElement(ArrangeWorkPage,{mode:'chat',workspace:{myEmployees:[employee],templates:[],arrangeSeed:null,busy:false,seedArrange:()=>{},navigate:()=>{},startConversation:async (...args)=>{window.calls.push(args)},chooseFolder:async()=>null}})));
root.render(React.createElement(LoginFixture));
</script></body></html>`;
const browser = await chromium.launch({channel:'msedge',headless:true});
try {
 const page = await browser.newPage(); const errors=[];
 page.on('pageerror', error => errors.push(error.message));
 await page.route('**/__login-settings-test', route => route.fulfill({contentType:'text/html',body:html}));
 for (const width of [1200,960]) {
  await page.setViewportSize({width,height:width===1200?800:640});
  await page.goto(origin+'/__login-settings-test');
  await page.getByLabel('邮箱',{exact:true}).fill('new@example.test');
  assert.equal(await page.getByLabel('邮箱',{exact:true}).inputValue(),'new@example.test','editing remembered email must not restore first account');
  await page.reload();
  await page.getByRole('button',{name:'显示密码',exact:true}).click();
  assert.equal(await page.getByLabel('密码',{exact:true}).inputValue(),'fixture-password');
  await page.getByRole('button',{name:'清空密码',exact:true}).click();
  assert.equal(await page.getByLabel('密码',{exact:true}).inputValue(),'');
  assert.ok(await page.getByRole('button',{name:'登录',exact:true}).isDisabled());
  await page.getByLabel('密码',{exact:true}).fill('replacement');
  await page.getByRole('button',{name:'登录',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.calls[0].useSavedPassword),false);
  await page.reload();
  await page.getByLabel('密码',{exact:true}).focus(); await page.keyboard.press('Backspace');
  assert.ok(await page.getByRole('button',{name:'登录',exact:true}).isDisabled());
  await page.reload();
  await page.evaluate(()=>{window.revealDelayed=true});
  await page.getByRole('button',{name:'显示密码',exact:true}).click();
  await page.getByRole('button',{name:'清空密码',exact:true}).click();
  await page.evaluate(()=>window.finishReveal());
  assert.equal(await page.getByLabel('密码',{exact:true}).inputValue(),'','late reveal must not restore a cleared password');
  await page.reload();
  await page.getByRole('button',{name:'选择历史账号'}).click();
  await page.evaluate(()=>{window.deleteFails=true});
  await page.getByRole('button',{name:'移除 one@example.test'}).click();
  await page.getByRole('alert').waitFor();
  assert.equal(await page.getByRole('button',{name:'移除 one@example.test'}).count(),1);
  await page.evaluate(()=>{window.deleteFails=false});
  await page.getByRole('button',{name:'移除 one@example.test'}).click();
  await page.getByRole('button',{name:'移除 one@example.test'}).waitFor({state:'detached'});
  assert.equal(await page.getByLabel('邮箱',{exact:true}).inputValue(),'');
  await page.screenshot({path:join(tmpdir(),`sep-login-fixed-${width}.png`)});
  await page.evaluate(()=>window.showChat());
  await page.getByRole('button',{name:'选择一位同事'}).waitFor();
  assert.ok(await page.getByRole('button',{name:'开始对话',exact:true}).isDisabled());
  await page.getByRole('button',{name:'选择一位同事'}).click();
  await page.getByRole('option',{name:'员工甲'}).click();
  await page.getByRole('button',{name:'执行设置',exact:true}).click();
  assert.equal(await page.getByRole('radio').count(),3);
  assert.equal(await page.getByLabel('模型',{exact:true}).inputValue(),'model-a');
  assert.doesNotMatch(await page.getByRole('dialog').innerText(),/由企业指定|通道打通/);
  await page.getByLabel('模型',{exact:true}).selectOption('model-b');
  await page.getByRole('radio',{name:/工作区编辑/}).check();
  await page.getByRole('checkbox',{name:/忽略权限风险/}).check();
  await page.screenshot({path:join(tmpdir(),`sep-settings-fixed-${width}.png`)});
  await page.keyboard.press('Escape');
  await page.locator('textarea').fill('测试任务');
  await page.getByRole('button',{name:'开始对话',exact:true}).click();
  const calls=await page.evaluate(()=>window.calls); const options=calls.at(-1)[2];
  assert.equal(options.modelId,'model-b'); assert.equal(options.permissions.preset,'workspace-edit'); assert.equal(options.permissions.approvalMode,'auto-approve');
 }
 assert.deepEqual(errors,[]); log('PASS login editing/reveal/clear/delete and task model/permissions at both viewport sizes');
} finally {await browser.close();}
