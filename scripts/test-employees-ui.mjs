/* global window, document, getComputedStyle, requestAnimationFrame */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const executablePath = [process.env.SEP_PREVIEW_BROWSER, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find(path => existsSync(path));
if (!executablePath) throw new Error('No Chromium browser found. Set SEP_PREVIEW_BROWSER.');
const server = await createServer({ configFile: 'vite.preview.config.ts', logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const browser = await chromium.launch({ executablePath, headless: true });
const outputDir = join(process.cwd(), 'output', 'playwright', 'employees');
mkdirSync(outputDir, { recursive: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1320, height: 900 } });
  const portraitRequests = [];
  await page.route('**/__employee_portrait_fixture__/**', async route => {
    portraitRequests.push(route.request().url());
    await route.abort();
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(new URL('features/enterprise/__fixtures__/employee-test.html', server.resolvedUrls.local[0]).href);
  const cards = page.locator('.ent-emp-card');
  const drawer = page.getByRole('dialog', { name: '员工详情', exact: true });
  const search = page.getByRole('searchbox', { name: '搜索员工或技能' });
  await cards.first().waitFor();
  assert.equal(await page.evaluate(() => 'electronAPI' in window), false);
  assert.equal(await cards.count(), 27);
  assert.equal(await cards.nth(5).locator('.employee-portrait image').count(), 0, 'Platform avatar is never spliced into a figure');
  assert.deepEqual(portraitRequests, [], 'People view never requests platform avatar assets');
  for (const [index, pose] of [[0, 'ready'], [2, 'working'], [3, 'unavailable'], [4, 'needs-auth']]) {
    assert.equal(await cards.nth(index).locator('.employee-portrait').getAttribute('data-pose'), pose);
  }
  assert.equal(await cards.first().locator('.employee-portrait').isVisible(), true);
  assert.equal(await cards.locator('[data-character="soft-digital-companion"]').count(), 27, 'Actual directory renders soft digital companions');
  assert.equal(await cards.locator('.employee-portrait-orbit').count(), 0, 'Glass avatar rings are removed');
  assert.equal(await cards.locator('.employee-portrait').evaluateAll(elements => elements.every(element => {
    const head = element.querySelector('.employee-portrait-head').getBoundingClientRect();
    const body = element.querySelector('.employee-portrait-body').getBoundingClientRect();
    return head.width >= 66 && head.height >= 59 && body.width >= 72 && body.height >= 76;
  })), true, 'Every generated shell has a complete visible head and body');
  assert.equal(await cards.first().locator('.employee-portrait-model').evaluate(element => Math.round(element.getBoundingClientRect().width)), 145, 'The 170px model is scaled down by 15%');
  assert.equal(await cards.locator('.ent-emp-speech').count(), 26, 'Only employees with real introduction or skills have a bubble');
  assert.equal(await cards.first().locator('.ent-emp-speech').textContent(), '我可以根据你提供的资料，整理分析结果并形成工作建议，擅长商品机会研究。');
  assert.equal(await cards.locator('.ent-emp-card-intro, .ent-emp-card-skills').count(), 0, 'Description and skill tags are no longer repeated under names');
  assert.equal(await cards.locator('.ent-chip').count(), 0, 'People view omits status pills beside employee names');
  const variedCompanions = await cards.locator('.employee-portrait').evaluateAll(elements => elements.filter(element => element.dataset.pose === 'ready').map(element => ({
    palette: element.dataset.palette,
    expression: element.dataset.expression,
    body: getComputedStyle(element.querySelector('.employee-portrait-body')).backgroundImage,
    eyes: Array.from(element.querySelectorAll('.employee-portrait-eye')).map(eye => {
      const style = getComputedStyle(eye);
      return [style.width, style.height, style.borderTopWidth, style.borderBottomWidth, style.borderRadius].join(':');
    }).join('|'),
  })));
  assert.equal(new Set(variedCompanions.map(item => item.palette)).size, 10, 'Directory employees cover all ten color identities');
  assert.equal(new Set(variedCompanions.map(item => item.body)).size, 10, 'All ten palettes visibly change the shell material');
  assert.ok(new Set(variedCompanions.map(item => item.expression)).size >= 4, 'Directory employees have distinct expressions');
  assert.ok(new Set(variedCompanions.map(item => item.eyes)).size >= 4, 'Expressions visibly change the rendered eyes');
  assert.equal(await cards.locator('.employee-portrait-hair, .employee-portrait-skin').count(), 0, 'Old human illustration is fully replaced');
  const personStyle = await cards.first().evaluate(element => ({ background: getComputedStyle(element).backgroundColor, border: getComputedStyle(element).borderWidth }));
  assert.deepEqual(personStyle, { background: 'rgba(0, 0, 0, 0)', border: '0px' }, 'People have no rectangular card surface');
  await search.focus();
  await page.mouse.move(5, 5);
  assert.equal(await cards.first().getByRole('button', { name: '开始对话' }).evaluate(element => getComputedStyle(element).opacity), '0');
  await cards.first().hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.ent-emp-chat')).opacity === '1');
  assert.equal(await cards.first().getByRole('button', { name: '开始对话' }).evaluate(element => getComputedStyle(element).opacity), '1', 'Mouse hover reveals conversation');
  await page.mouse.move(5, 5);
  await cards.first().locator('.ent-emp-open').focus();
  assert.equal(await cards.first().getByRole('button', { name: '开始对话' }).evaluate(element => getComputedStyle(element).opacity), '1', 'Keyboard focus reveals conversation');
  assert.equal(await cards.first().locator('.employee-portrait').evaluate(element => getComputedStyle(element).transform), 'none', 'Reduced motion disables figure lift');
  await search.focus();
  assert.equal(await page.getByRole('button', { name: '查看详情', exact: true }).count(), 0);
  assert.equal(await page.getByRole('heading', { name: '硅基员工', exact: true }).count(), 0);
  for (const [width, columns] of [[1440, 4], [1120, 3], [590, 2]]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForFunction(expected => getComputedStyle(document.querySelector('.ent-emp-grid')).gridTemplateColumns.split(' ').length === expected, columns);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `No horizontal overflow at ${width}`);
    assert.equal(await cards.evaluateAll(elements => elements.every(element => {
      const name = element.querySelector('header strong').getBoundingClientRect();
      const card = element.getBoundingClientRect();
      return Math.abs(name.left + name.width / 2 - card.left - card.width / 2) < 1;
    })), true, `Employee names are centered at ${width}`);
    assert.equal(await cards.first().evaluate(element => element.querySelector('.employee-portrait').getBoundingClientRect().bottom <= element.querySelector('header').getBoundingClientRect().top), true, `Portrait and name do not overlap at ${width}`);
    assert.equal(await cards.locator('.employee-portrait-laptop, .employee-portrait-document').evaluateAll(elements => elements.every(element => element.getBoundingClientRect().bottom < element.closest('article').querySelector('header').getBoundingClientRect().top)), true, `Status props do not overlap names at ${width}`);
    assert.equal(await cards.evaluateAll(elements => elements.every(element => {
      const bubble = element.querySelector('.ent-emp-speech');
      if (!bubble) return true;
      const text = bubble.querySelector('p');
      const bounds = bubble.getBoundingClientRect();
      const card = element.getBoundingClientRect();
      const head = element.querySelector('.employee-portrait-head').getBoundingClientRect();
      return bounds.left >= card.left && bounds.right <= card.right && bounds.bottom + 5 <= head.top && text.getBoundingClientRect().height <= 54;
    })), true, `Bubbles stay inside columns and above faces at ${width}`);
    await page.screenshot({ path: join(outputDir, `people-${width}.png`) });
  }
  await page.setViewportSize({ width: 1320, height: 900 });
  await search.fill('机会评估');
  assert.equal(await cards.count(), 1);
  await search.fill('独特的会员');
  assert.equal(await cards.count(), 1);
  await search.fill('商品机会研究');
  assert.equal(await cards.count(), 1);
  await page.getByLabel('按可用状态筛选').selectOption('working');
  assert.equal(await cards.count(), 0);
  await page.getByRole('button', { name: '清除筛选' }).first().click();
  await page.getByRole('button', { name: '企业全部员工', exact: true }).click();
  assert.equal(await cards.count(), 30);
  const unassigned = cards.filter({ hasText: '企业员工 28' });
  assert.equal(await unassigned.getByRole('button', { name: '开始对话' }).isDisabled(), true);
  await unassigned.locator('.ent-emp-open').click();
  await page.getByRole('heading', { name: '企业员工 28' }).waitFor();
  assert.equal(await drawer.getByRole('button', { name: '开始对话', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '关闭员工详情', exact: true }).click();
  assert.equal(await cards.count(), 30);
  await page.getByRole('button', { name: '分配给我的', exact: true }).click();
  await page.getByRole('button', { name: '紧凑列表', exact: true }).click();
  assert.equal(await page.locator('.ent-emp-row').count(), 27);
  await page.screenshot({ path: join(outputDir, 'list-light.png') });
  await page.getByRole('button', { name: '切换主题' }).click();
  await page.screenshot({ path: join(outputDir, 'list-dark.png') });
  await page.getByRole('button', { name: '切换主题' }).click();
  await page.getByRole('button', { name: '人物视图', exact: true }).click();
  await cards.first().evaluate(element => { element.dataset.persisted = 'directory-node'; });
  await cards.first().getByRole('button', { name: '开始对话' }).click();
  assert.equal(await drawer.count(), 0, 'Chat button must not open the employee drawer');
  assert.deepEqual(JSON.parse(await page.getByTestId('destination').textContent()), { name: 'arrange', mode: 'chat', employeeId: 'employee-1' });
  await page.getByRole('button', { name: '返回来源' }).click();
  await cards.first().locator('.ent-emp-open').click();
  assert.equal(await cards.first().getAttribute('data-persisted'), null, 'Navigation to chat remounts the list normally');
  await cards.first().evaluate(element => { element.dataset.persisted = 'drawer-background'; });
  assert.equal(await drawer.getByRole('button', { name: '开始对话', exact: true }).isEnabled(), true);
  assert.equal(await page.locator('.ent-employee-work-link').count(), 3);
  assert.equal(await page.locator('textarea').count(), 0);
  assert.equal(await page.getByRole('button', { name: '语音输入', exact: true }).count(), 0);
  await page.screenshot({ path: join(outputDir, 'drawer-light.png') });
  await page.setViewportSize({ width: 590, height: 900 });
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  const narrowDrawer = await page.evaluate(() => ({
    count: document.querySelectorAll('.ent-employee-drawer').length,
    openCount: document.querySelectorAll('.ent-employee-drawer[open]').length,
    headerCount: document.querySelectorAll('.ent-employee-drawer-heading').length,
    viewport: { width: window.innerWidth, height: window.innerHeight, scrollY: window.scrollY },
    dialog: document.querySelector('.ent-employee-drawer').getBoundingClientRect().toJSON(),
    panel: document.querySelector('.ent-employee-drawer-panel').getBoundingClientRect().toJSON(),
    header: document.querySelector('.ent-employee-drawer-heading').getBoundingClientRect().toJSON(),
  }));
  assert.equal(narrowDrawer.count, 1);
  assert.equal(narrowDrawer.openCount, 1);
  assert.equal(narrowDrawer.headerCount, 1);
  assert.equal(narrowDrawer.dialog.height, 900);
  writeFileSync(join(outputDir, 'drawer-narrow-layout.json'), JSON.stringify(narrowDrawer, null, 2));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: join(outputDir, 'drawer-narrow.png') });
  await page.setViewportSize({ width: 1320, height: 900 });
  await page.getByRole('button', { name: '关闭员工详情', exact: true }).click();
  assert.equal(await cards.first().getAttribute('data-persisted'), 'drawer-background', 'Closing drawer keeps the original list DOM mounted');
  await cards.first().locator('.ent-emp-open').click();
  await page.getByRole('button', { name: '查看技能', exact: true }).click();
  assert.deepEqual(JSON.parse(await page.getByTestId('destination').textContent()), { name: 'skills', skillId: 'skill-1', sourceEmployeeId: 'employee-1', returnTo: { name: 'employee', employeeId: 'employee-1' } });
  await page.getByRole('button', { name: '返回来源' }).click();
  await page.locator('.ent-employee-work-link').first().click();
  assert.deepEqual(JSON.parse(await page.getByTestId('destination').textContent()), { name: 'work', workId: 'work-1' });
  await page.getByRole('button', { name: '返回来源' }).click();
  await page.getByRole('button', { name: '关闭员工详情', exact: true }).click();
  await page.getByRole('button', { name: '切换主题' }).click();
  await cards.first().locator('.ent-emp-open').click();
  await page.screenshot({ path: join(outputDir, 'drawer-dark.png') });
  await page.getByRole('button', { name: '关闭员工详情', exact: true }).click();
  await page.screenshot({ path: join(outputDir, 'people-dark.png') });
  await page.getByRole('button', { name: '切换主题' }).click();
  await page.evaluate(() => { document.querySelector('.ent-scroll').scrollTop = 700; });
  await page.waitForFunction(() => document.querySelector('.ent-scroll').scrollTop >= 700);
  const target = cards.nth(10).locator('.ent-emp-open');
  await target.scrollIntoViewIfNeeded();
  const before = await page.locator('.ent-scroll').evaluate(element => element.scrollTop);
  const targetId = await target.getAttribute('id');
  await target.click();
  await page.getByRole('button', { name: '关闭员工详情', exact: true }).click();
  await page.waitForFunction(expected => Math.abs(document.querySelector('.ent-scroll').scrollTop - expected) <= 1, before);
  assert.equal(await page.evaluate(() => document.activeElement.id), targetId);
  await target.click();
  assert.equal(await page.locator('.ent-scroll').evaluate(element => element.scrollTop), before, 'Opening drawer preserves background scroll');
  for (let index = 0; index < 10; index += 1) {
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => !document.querySelector('.ent-scroll').contains(document.activeElement)), true, 'Tab focus never reaches the background page');
  }
  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement.id), targetId);
  await target.click();
  await page.mouse.click(10, 300);
  await drawer.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement.id), targetId, 'Backdrop close restores card focus');
  await page.getByRole('button', { name: '重新进入我的员工' }).click();
  await cards.first().locator('.ent-emp-open').scrollIntoViewIfNeeded();
  const bubbleBox = await cards.first().locator('.ent-emp-speech').boundingBox();
  await page.mouse.click(bubbleBox.x + bubbleBox.width / 2, bubbleBox.y + bubbleBox.height / 2);
  await drawer.waitFor();
  await page.getByRole('button', { name: '关闭员工详情', exact: true }).click();
  const firstCardBox = await cards.first().boundingBox();
  await page.mouse.click(firstCardBox.x + firstCardBox.width - 15, firstCardBox.y + firstCardBox.height - 15);
  await drawer.waitFor();
  await drawer.getByRole('button', { name: '开始对话', exact: true }).click();
  assert.equal(await drawer.count(), 0);
  assert.deepEqual(JSON.parse(await page.getByTestId('destination').textContent()), { name: 'arrange', mode: 'chat', employeeId: 'employee-1' });
  await page.getByRole('button', { name: '返回来源' }).click();
  await drawer.waitFor();
  await page.getByRole('button', { name: '关闭员工详情', exact: true }).click();
  await search.fill('资料助手');
  assert.equal(await cards.first().locator('.ent-emp-speech').count(), 0);
  assert.equal(await cards.first().locator('.ent-emp-card-intro').count(), 0);
  assert.equal(await cards.first().locator('.ent-emp-card-skills').count(), 0);
  await cards.first().locator('.ent-emp-open').click();
  assert.equal(await page.getByRole('heading', { name: '最近工作', exact: true }).count(), 0);
  await page.getByRole('button', { name: '关闭员工详情', exact: true }).click();
  assert.equal(await search.inputValue(), '资料助手');
  await page.getByRole('button', { name: '紧凑列表', exact: true }).click();
  await page.getByRole('button', { name: '切换账号' }).click();
  assert.equal(await search.inputValue(), '');
  assert.equal(await cards.count(), 27);
  await page.getByLabel('数据场景').selectOption('loading');
  await page.getByText('正在加载员工列表…', { exact: true }).waitFor();
  await page.getByLabel('数据场景').selectOption('skills-loading');
  await page.getByText('技能正在加载，搜索结果暂不完整。', { exact: true }).waitFor();
  await page.getByLabel('数据场景').selectOption('rate-limit');
  assert.equal(await page.getByRole('button', { name: /10 秒后重试/ }).isDisabled(), true);
  await page.getByLabel('数据场景').selectOption('skills-error');
  await page.getByText(/当前仅可搜索员工名称和介绍/).waitFor();
  await page.getByRole('button', { name: '重试技能', exact: true }).click();
  assert.equal(await cards.count(), 27);
  await page.getByRole('button', { name: '企业全部员工', exact: true }).click();
  await page.getByLabel('数据场景').selectOption('organization-error');
  await page.getByText('企业目录加载失败', { exact: true }).waitFor();
  await page.getByLabel('数据场景').selectOption('ready');
  await page.getByRole('button', { name: '进入首页来源' }).click();
  await page.getByRole('button', { name: '从首页查看员工' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: '爆品机会评估师', exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭员工详情', exact: true }).click();
  assert.deepEqual(JSON.parse(await page.getByTestId('destination').textContent()), { name: 'home' });
  await page.getByRole('button', { name: '重新进入我的员工' }).click();
  await page.getByRole('button', { name: '企业全部员工', exact: true }).focus();
  await page.keyboard.press('Space');
  assert.equal(await cards.count(), 30);
  await search.focus();
  await page.keyboard.type('商品机会研究');
  assert.equal(await cards.count(), 1);
  await page.getByLabel('按可用状态筛选').selectOption('ready');
  await cards.first().getByRole('button', { name: '开始对话' }).focus();
  await page.keyboard.press('Enter');
  assert.deepEqual(JSON.parse(await page.getByTestId('destination').textContent()), { name: 'arrange', mode: 'chat', employeeId: 'employee-1' });
  await page.getByRole('button', { name: '返回来源' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '重新进入我的员工' }).click();
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.ent-emp-grid')).gridTemplateColumns.split(' ').length === 2);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'No horizontal overflow at 200% CSS zoom');
  await cards.first().locator('.ent-emp-open').focus();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: '爆品机会评估师', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Detail fits at 200% CSS zoom');
  await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('.ent-scroll').scrollTop = 0; });
  await page.screenshot({ path: join(outputDir, 'drawer-zoom-200.png') });
  await page.evaluate(() => { document.documentElement.style.zoom = ''; });
  const touchPage = await browser.newPage({ viewport: { width: 590, height: 900 }, hasTouch: true, isMobile: true });
  touchPage.on('pageerror', error => errors.push(error.message));
  await touchPage.goto(new URL('features/enterprise/__fixtures__/employee-test.html', server.resolvedUrls.local[0]).href);
  const touchPerson = touchPage.locator('.ent-emp-person').first();
  await touchPerson.waitFor();
  assert.equal(await touchPerson.getByRole('button', { name: '开始对话' }).evaluate(element => getComputedStyle(element).opacity), '1', 'Touch keeps conversation action visible');
  await touchPerson.locator('.ent-emp-open').tap();
  await touchPage.getByRole('dialog', { name: '员工详情', exact: true }).waitFor();
  await touchPage.close();
  const posePage = await browser.newPage({ viewport: { width: 1120, height: 1000 } });
  const poseRequests = [];
  posePage.on('pageerror', error => errors.push(error.message));
  await posePage.route('**/__employee_portrait_fixture__/**', async route => { poseRequests.push(route.request().url()); await route.abort(); });
  await posePage.goto(new URL('features/enterprise/__fixtures__/employee-portrait-test.html', server.resolvedUrls.local[0]).href);
  const comparison = posePage.getByRole('region', { name: '四种员工状态' });
  await comparison.locator('.employee-portrait').first().waitFor();
  const identities = await comparison.locator('.employee-portrait').evaluateAll(elements => elements.map(element => element.dataset.appearance));
  assert.equal(new Set(identities).size, 1, 'One employee retains the same appearance in all states');
  assert.deepEqual(await comparison.locator('.employee-portrait').evaluateAll(elements => elements.map(element => element.dataset.pose)), ['ready', 'working', 'unavailable', 'needs-auth']);
  assert.equal(new Set(await comparison.locator('.employee-portrait').evaluateAll(elements => elements.map(element => element.innerHTML))).size, 4, 'All four poses have different rendered geometry');
  const live = posePage.getByTestId('live-portrait').locator('.employee-portrait');
  const identity = await live.getAttribute('data-appearance');
  for (const state of ['working', 'unavailable', 'needs-auth', 'ready']) {
    await posePage.getByLabel('员工姿势').selectOption(state);
    await posePage.waitForFunction(expected => document.querySelector('[data-testid="live-portrait"] .employee-portrait').dataset.pose === expected, state);
    assert.equal(await live.getAttribute('data-appearance'), identity, 'Live state updates preserve identity');
    assert.equal(await live.locator('.employee-portrait-laptop').isVisible(), state === 'working');
    assert.equal(await live.locator('.employee-portrait-document').isVisible(), state === 'needs-auth');
  }
  await posePage.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  await posePage.screenshot({ path: join(outputDir, 'portrait-states-light.png'), fullPage: true });
  await posePage.getByRole('button', { name: '切换主题' }).click();
  await posePage.screenshot({ path: join(outputDir, 'portrait-states-dark.png'), fullPage: true });
  await posePage.getByRole('button', { name: '切换主题' }).click();
  await posePage.setViewportSize({ width: 590, height: 1000 });
  await posePage.evaluate(async () => { await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  assert.equal(await posePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await posePage.screenshot({ path: join(outputDir, 'portrait-states-narrow.png'), fullPage: true });
  await posePage.close();
  assert.deepEqual(poseRequests, [], 'Full vector figures never request platform avatar assets');
  assert.deepEqual(errors, []);
  console.log('PASS: employee responsive layouts, true scopes, search, details, navigation, return restoration, account isolation and failure states');
} finally {
  await browser.close();
  await server.close();
}
