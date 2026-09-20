/* global window, document, fetch */
// Test-only browser fixture. No demo data or IPC is installed in the application.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { log } from 'node:console';
import { chromium } from 'playwright-core';

const origin = process.env.SEP_PREVIEW_ORIGIN ?? 'http://127.0.0.1:5174';
const mainModule = await (await fetch(origin + '/main.tsx')).text();
const reactUrl = mainModule.match(/from "([^"]+\/react\.js[^"]*)"/)[1];
const reactDomUrl = mainModule.match(/from "([^"]+\/react-dom_client\.js[^"]*)"/)[1];
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div>
<script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => type => type;
window.__vite_plugin_react_preamble_installed__ = true;
await import('/index.css');
await import('/styles/enterprise.css');
const React = (await import('${reactUrl}')).default;
const { createRoot } = (await import('${reactDomUrl}')).default;
const { EmployeesPage } = await import('/pages/enterprise/EmployeesPage.tsx');
const { EmployeeDetailPage } = await import('/pages/enterprise/EmployeeDetailPage.tsx');
const employee = { id: 'fixture-1', name: '测试员工用于验证较长名称不会遮挡操作按钮', mark: '测', roleName: 'LEGACY_ROLE', department: 'LEGACY_DEPARTMENT', availability: 'ready', assignedToMe: true, intro: '仅用于自动化测试的员工介绍。', goodAt: ['整理资料'], cannotDo: [], lastWorkedAt: null, allowedModels: [], skillIds: [], permissions: [], templateVersion: '1.0' };
const employees = [employee, { ...employee, id: 'fixture-2', name: '不可用测试员工', availability: 'unavailable' }];
window.testRoutes = [];
const workspace = { employees, skills: [], busy: false, navigate: route => { window.testRoutes.push(route); if (route.name === 'employee') renderDetail(route.employeeId); }, startConversation: async () => {} };
const root = createRoot(document.getElementById('root'));
function render(component, props) { root.render(React.createElement('div', {className: 'ent-shell', style: {display: 'block', padding: 24}}, React.createElement(component, props))); }
function renderDetail(employeeId) { render(EmployeeDetailPage, {workspace, employeeId}); }
render(EmployeesPage, {workspace});
</script></body></html>`;
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/__employee-ui-test', route => route.fulfill({ contentType: 'text/html', body: html }));
  for (const width of [1200, 960]) {
    await page.setViewportSize({ width, height: width === 1200 ? 800 : 640 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${origin}/__employee-ui-test`);
    await page.locator('.ent-emp-card').first().waitFor();
    assert.doesNotMatch(await page.locator('body').innerText(), /LEGACY_ROLE|LEGACY_DEPARTMENT|安排工作|全部部门|全部职能/);
    assert.equal(await page.getByRole('button', {name: '开始对话', exact: true}).count(), 2);
    assert.equal(await page.getByRole('button', {name: '查看技能', exact: true}).count(), 2);
    await page.getByRole('searchbox').fill('LEGACY_ROLE');
    assert.equal(await page.locator('.ent-emp-card').count(), 0);
    await page.getByRole('searchbox').fill('整理资料');
    assert.equal(await page.locator('.ent-emp-card').count(), 2);
    await page.getByRole('searchbox').fill('');
    await page.getByLabel('按可用状态筛选').selectOption('ready');
    assert.equal(await page.locator('.ent-emp-card').count(), 1);
    await page.getByLabel('按可用状态筛选').selectOption('');
    await page.screenshot({path: join(tmpdir(), `sep-employees-grid-${width}.png`)});
    await page.getByRole('button', {name: '紧凑列表', exact: true}).click();
    assert.equal(await page.locator('.ent-emp-row').count(), 2);
    assert.equal(await page.locator('.ent-emp-row').nth(1).getByRole('button', {name: '开始对话'}).isDisabled(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({path: join(tmpdir(), `sep-employees-list-${width}.png`)});
    await page.getByRole('button', {name: '开始对话', exact: true}).first().focus();
    await page.keyboard.press('Enter');
    await page.locator('.ent-detail-head').waitFor();
    assert.doesNotMatch(await page.locator('body').innerText(), /LEGACY_ROLE|LEGACY_DEPARTMENT|安排工作/);
    await page.getByRole('button', {name: '开始对话', exact: true}).click();
    assert.equal(await page.locator('.ent-detail-composer textarea').evaluate(element => element === document.activeElement), true);
    await page.getByRole('button', {name: '查看技能', exact: true}).click();
    assert.deepEqual(await page.evaluate(() => window.testRoutes.at(-1)), {name: 'skills'});
    await page.screenshot({path: join(tmpdir(), `sep-employees-detail-${width}.png`)});
  }
  assert.deepEqual(errors, []);
  log('PASS: employee list/detail, filtering, compact actions and navigation at 1200x800 and 960x640');
} finally { await browser.close(); }
