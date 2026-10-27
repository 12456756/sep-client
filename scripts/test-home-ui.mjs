import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import process from 'node:process';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

function findBrowserExecutable() {
  const candidates = [process.env.SEP_PREVIEW_BROWSER,
    process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null,
    process.platform === 'darwin' ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' : null,
    '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
  return candidates.find(path => existsSync(path));
}

const executablePath = findBrowserExecutable();
if (!executablePath) throw new Error('No Chromium browser found. Set SEP_PREVIEW_BROWSER before running the home preview check.');
const browser = await chromium.launch({ executablePath, headless: true });
const outputDir = process.env.SEP_PREVIEW_OUTPUT_DIR ?? join(process.cwd(), 'output', 'playwright', 'home-reference');
mkdirSync(outputDir, { recursive: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1586, height: 992 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.SEP_PREVIEW_URL ?? 'http://127.0.0.1:5174/?preview=home');
  await page.locator('.sep-home').waitFor();
  assert.equal(await page.evaluate(() => 'electronAPI' in window), false, 'Preview must not install fake IPC');
  assert.equal(await page.locator('.ent-side.collapsed').count(), 1, 'Shared side navigation starts collapsed');
  await page.getByRole('button', { name: '展开侧栏' }).click();
  assert.equal(await page.locator('.ent-side.collapsed').count(), 0, 'Shared side navigation can expand');
  await page.getByRole('button', { name: '收起侧栏' }).click();
  assert.equal(await page.locator('.ent-side.collapsed').count(), 1, 'Shared side navigation can collapse again');

  for (const viewport of [{ width: 1586, height: 992 }, { width: 1440, height: 900 }, { width: 1200, height: 800 }, { width: 960, height: 640 }]) {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    await page.locator('.sep-home').waitFor();
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); document.querySelector('.ent-scroll').scrollTop = 0; });
    await page.getByRole('region', { name: '我的智能体' }).waitFor();
    await page.getByRole('region', { name: '热门推荐' }).waitFor();
    await page.getByRole('region', { name: '最近任务' }).waitFor();
    assert.equal(await page.locator('.sep-home').innerText().then(text => text.includes('常用工具')), false, 'Common tools block is deferred');
    assert.equal(await page.locator('.sep-home-employee').count(), 5);
    assert.equal(await page.locator('.sep-home-popular-grid > *').count(), 6);
    assert.equal(await page.locator('.sep-home-recent-row').count(), 5);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `No horizontal overflow at ${viewport.width}px`);
    await page.screenshot({ path: join(outputDir, `home-${viewport.width}.png`), fullPage: true });

    await page.getByRole('button', { name: '选择智能体' }).click();
    await page.getByRole('dialog', { name: '选择智能体' }).waitFor();
    await page.getByRole('dialog').getByRole('button', { name: /爆品机会评估师/ }).click();
    await page.getByRole('button', { name: '上下文', exact: true }).click();
    await page.getByRole('textbox', { name: '补充背景信息' }).fill('演示上下文检查');
    await page.getByRole('button', { name: '保存上下文' }).click();
    await page.getByRole('textbox', { name: '工作需求' }).fill('请生成一份周报');
    await page.getByRole('button', { name: '发送需求' }).click();
    await page.getByRole('dialog', { name: '演示模式' }).waitFor();
    await page.getByRole('button', { name: '知道了' }).click();
    await page.getByRole('button', { name: /工具中心/ }).click();
    await page.getByRole('dialog', { name: '工具中心' }).getByText('工具中心暂未开放').waitFor();
    await page.keyboard.press('Escape');

    const themeButton = page.getByRole('button', { name: '切换到深色主题' });
    await themeButton.click();
    assert.equal(await page.locator('.ent-shell.dark').count(), 1);
    await page.evaluate(() => { document.querySelector('.ent-scroll').scrollTop = 0; });
    await page.screenshot({ path: join(outputDir, `home-${viewport.width}-dark.png`), fullPage: true });
    await page.getByRole('button', { name: '切换到浅色主题' }).click();
  }
  assert.deepEqual(errors, []);
  console.log('PASS: homepage sections, fixtures, no common tools, responsive layout, preview interactions and theme verified');
} finally {
  await browser.close();
}
