/* global window, document, fetch */
// Real ClientAppPage + workspace hook, controlled IPC only. No platform writes.
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { log } from 'node:console';
import { chromium } from 'playwright-core';
const origin = process.env.SEP_PREVIEW_ORIGIN ?? 'http://127.0.0.1:5174';
const main = await (await fetch(origin + '/main.tsx')).text();
const reactUrl = main.match(/from "([^"]*react\.js[^"]*)"/)[1];
const domUrl = main.match(/from "([^"]*react-dom_client[^"]*)"/)[1];
const html = readFileSync(new URL('./fixtures/organization.html', import.meta.url), 'utf8').replace('__REACT__', reactUrl).replace('__DOM__', domUrl);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const [width, height, reducedMotion] of [[1200,800,'no-preference'],[960,640,'reduce']]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/__organization-test', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto(origin + '/__organization-test');
    await page.getByText('正在加载组织架构', { exact: true }).waitFor();
    await page.evaluate(() => window.deliver('error'));
    await page.getByRole('alert').filter({ hasText: '测试：SEP 暂时不可用' }).waitFor();
    const retry = page.getByRole('button', { name: '重新加载', exact: true });
    await retry.focus();
    assert.equal(await retry.evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('Enter');
    await page.getByText('正在加载组织架构', { exact: true }).waitFor();
    await page.evaluate(() => window.deliver('empty'));
    await page.getByText('平台暂无企业成员数据', { exact: true }).waitFor();
    assert.equal(await page.locator('.org-tree').count(), 0);
    await retry.click();
    await page.evaluate(() => window.deliver('ready'));
    await page.getByRole('region', { name: '企业组织关系图' }).waitFor();
    const search = page.getByRole('searchbox', { name: '搜索员工', exact: true });
    await search.fill('测试成员甲');
    await page.locator('.org-tree-card-main').filter({ hasText: '测试成员甲' }).click();
    const drawer = page.getByRole('complementary', { name: '成员详情' });
    await drawer.getByRole('heading', { name: '测试成员甲', exact: true }).waitFor();
    assert.equal(await drawer.getByRole('button', { name: '查看 直接授权分析员 详情' }).isDisabled(), true);
    assert.equal(await drawer.getByRole('button', { name: '查看 部门授权分析员 详情' }).isDisabled(), true);
    assert.equal(await drawer.getByText('当前成员', { exact: true }).count(), 1);
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'detached' });
    await search.fill('测试成员乙');
    await page.locator('.org-tree-card-main').filter({ hasText: '测试成员乙' }).click();
    await drawer.getByText('暂未配置可用的硅基员工', { exact: true }).waitFor();
    assert.equal(await drawer.getByText('部门授权分析员', { exact: true }).count(), 0);
    await page.keyboard.press('Escape');
    await search.fill('无部门成员');
    await page.locator('.org-tree-card-main').filter({ hasText: '无部门成员' }).click();
    await drawer.getByText('企业直属', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await search.fill('测试成员乙');
    await page.locator('.org-tree-card-main').filter({ hasText: '测试成员乙' }).waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false, 'page must not overflow horizontally');
    await page.screenshot({ path: join(tmpdir(), `sep-organization-${width}.png`) });
    // Resolve an old scope after a new scope: stale organization must never win.
    await page.evaluate(() => window.setScope({userId:'user-2',enterpriseId:'enterprise-2'}));
    await page.getByText('正在加载组织架构', { exact: true }).waitFor();
    const oldIndex = await page.evaluate(() => window.pending.length - 1);
    await page.evaluate(() => window.setScope({userId:'user-3',enterpriseId:'enterprise-3'}));
    await page.waitForFunction(index => window.pending.length > index + 1, oldIndex);
    await page.evaluate(() => window.deliver('empty'));
    await page.getByText('平台暂无企业成员数据', { exact: true }).waitFor();
    await page.evaluate(index => window.deliver('ready', index), oldIndex);
    assert.equal(await page.locator('.org-tree').count(), 0);
    await retry.click();
    await page.evaluate(() => window.deliver('reject'));
    await page.getByRole('alert').filter({hasText:'测试：网络已断开'}).waitFor();
    assert.deepEqual(errors, []);
    log('PASS organization UI', {width,height,reducedMotion,checks:'loading/error/retry/empty/hierarchy/grants/scope/keyboard/overflow'});
    await page.close();
  }
} finally { await browser.close(); }
