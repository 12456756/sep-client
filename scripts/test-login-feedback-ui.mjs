/* global window, document, fetch */
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
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
await import('/index.css');
const React=(await import('${reactUrl}')).default;
const {createRoot}=(await import('${domUrl}')).default;
const {LoginPage}=await import('/pages/LoginPage.tsx');
const {FeedbackProvider,useFeedback}=await import('/components/feedback/FeedbackProvider.tsx');
window.calls=[];window.deleteCalls=0;window.saved=false;window.encryption=true;
window.electronAPI={
 login:async input=>{window.calls.push(input);if(window.loginDelayed)await new Promise(resolve=>{window.finishLogin=resolve});return {success:false,error:window.loginError??{reason:'credentials',message:'账号或密码错误'}}},
 forgetAccount:async()=>{window.deleteCalls++;if(window.deleteDelayed)await new Promise(resolve=>{window.finishDelete=resolve});return window.deleteFails?{success:false,error:{message:'历史账号移除失败，请联系平台管理员'}}:{success:true}},
 revealRememberedPassword:async()=>{if(window.revealDelayed)await new Promise(resolve=>{window.finishReveal=resolve});return window.revealError?{password:null,error:{message:'保存的密码读取失败，请联系平台管理员'}}:{password:'fixture-password'}}
};
function Fixture(){
 const feedback=useFeedback();window.feedback=feedback;
 const [accounts,setAccounts]=React.useState(window.saved?[{email:'one@example.test',displayName:'One',enterpriseName:'Test',lastLoginAt:new Date().toISOString(),hasSavedPassword:true}]:[]);
 return React.createElement(LoginPage,{encryptionAvailable:window.encryption,rememberedAccounts:accounts,onAccountListChange:setAccounts,onLoginSuccess:()=>{}});
}
const root=createRoot(document.getElementById('root'));
window.mount=()=>root.render(React.createElement(FeedbackProvider,{key:Math.random()},React.createElement(Fixture)));
window.mount();
</script></body></html>`;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const [width, height] of [[1200, 800], [375, 740]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on('pageerror', error => { errors.push(error.message); log('Browser error:', error.message); });
    page.on('console', message => { if (message.type() === 'error') log('Browser console:', message.text()); });
    page.setDefaultTimeout(10000);
    await page.route('**/__login-feedback-test', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto(origin + '/__login-feedback-test');
    const dialog = page.getByRole('dialog');
    const submit = page.getByRole('button', { name: '登录', exact: true });
    const email = page.getByLabel('邮箱', { exact: true });
    const password = page.getByLabel('密码', { exact: true });
    const close = () => page.getByRole('button', { name: '知道了', exact: true }).click();
    for (const [emailValue, passwordValue, message] of [['', '', '请输入邮箱'], ['invalid', '', '请输入有效的邮箱地址'], ['test@example.test', '', '请输入密码']]) {
      await email.fill(emailValue); await password.fill(passwordValue); await submit.click();
      await dialog.filter({ hasText: message }).waitFor(); await close();
    }
    assert.equal(await page.evaluate(() => window.calls.length), 0);
    await password.fill('fixture-password');
    for (const message of ['账号或密码错误', '登录验证未通过', '登录请求被拒绝，请联系平台管理员', '登录操作过于频繁，请稍后再试', '网络连接失败，请检查网络', '网络连接超时，请稍后再试', '登录响应异常，请联系平台管理员']) {
      await page.evaluate(message => { window.loginError = { message }; }, message);
      await submit.click(); await dialog.filter({ hasText: message }).waitFor();
      assert.equal(await email.inputValue(), 'test@example.test');
      assert.equal(await password.inputValue(), 'fixture-password');
      await page.mouse.click(4, 60); assert.equal(await dialog.count(), 1);
      await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
    }
    await submit.click(); await dialog.waitFor();
    await page.waitForTimeout(2200); assert.equal(await dialog.count(), 1, 'errors must not auto-dismiss');
    await page.screenshot({ path: join(tmpdir(), 'sep-login-feedback-light-' + width + '.png') });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.screenshot({ path: join(tmpdir(), 'sep-login-feedback-dark-' + width + '.png') });
    assert.ok(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth));
    assert.ok(await dialog.evaluate(element => { const box = element.getBoundingClientRect(); return box.left >= 16 && box.right <= window.innerWidth - 16; }));
    await close();
    await page.evaluate(() => { window.saved = true; window.mount(); });
    const remove = async () => {
      await page.getByRole('button', { name: '选择历史账号' }).click();
      await page.getByRole('button', { name: '移除 one@example.test' }).click();
      await dialog.filter({ hasText: '确认移除' }).waitFor();
    };
    await remove();
    assert.equal(await page.getByRole('button', { name: '取消', exact: true }).evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('Escape'); assert.equal(await page.evaluate(() => window.deleteCalls), 0);
    await page.evaluate(() => { window.deleteDelayed = true; window.deleteFails = true; });
    await remove(); await page.getByRole('button', { name: '移除', exact: true }).click();
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('button', { name: '取消', exact: true }).isDisabled(), true);
    assert.equal(await dialog.count(), 1);
    await page.evaluate(() => window.finishDelete());
    await dialog.filter({ hasText: '历史账号移除失败' }).waitFor();
    assert.equal(await page.evaluate(() => window.deleteCalls), 1);
    assert.equal(await email.inputValue(), 'one@example.test'); await close();
    await page.evaluate(() => { window.deleteDelayed = false; window.deleteFails = false; });
    await remove(); await page.getByRole('button', { name: '移除', exact: true }).click();
    await dialog.filter({ hasText: '已移除此设备' }).waitFor();
    await page.waitForTimeout(2200); await dialog.waitFor({ state: 'detached' });
    assert.equal(await email.inputValue(), '');
    // A queued success starts its timer when it becomes visible.
    await page.evaluate(() => { window.feedback.show({ tone: 'error', message: '前一条错误' }); window.feedback.show({ tone: 'success', message: '后一条成功' }); });
    await dialog.filter({ hasText: '前一条错误' }).waitFor();
    await page.waitForTimeout(2100); await close();
    await dialog.filter({ hasText: '后一条成功' }).waitFor();
    await page.waitForTimeout(1000); assert.equal(await dialog.count(), 1);
    await page.waitForTimeout(1200); await dialog.waitFor({ state: 'detached' });
    // Old login errors cannot surface after a session reset.
    await email.fill('test@example.test'); await password.fill('fixture-password');
    await page.evaluate(() => { window.loginDelayed = true; }); await submit.click();
    await page.waitForFunction(() => Boolean(window.finishLogin));
    await page.evaluate(() => { window.feedback.clear(); window.finishLogin(); });
    await submit.waitFor({ state: 'visible' });
    await page.waitForTimeout(100); assert.equal(await dialog.count(), 0);
    assert.deepEqual(errors, []); log('PASS login feedback', { width, height });
    await page.close();
  }
} finally { await browser.close(); }
