#!/usr/bin/env node
/**
 * 截图脚手架驱动（临时工具，不属于产品构建）。
 *
 * 用 playwright-core + 本机缓存的 headless chromium，访问 vite harness
 * （src/harness/harness.html，渲染真实的 <ClientAppPage> + 内存 mock），
 * 通过点击把每个页面/状态走一遍并截图，作为重构前的视觉基线。
 *
 * 用法：
 *   1) 另起一个终端跑：npx vite --config vite.harness.config.ts
 *   2) node scripts/harness-screenshot.mjs
 * 截图落在 docs/plans/screenshots/。
 */
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(projectRoot, '..');
const OUT = resolve(repoRoot, 'docs/plans/screenshots');
const BASE = 'http://127.0.0.1:5199/harness/harness.html';

const SHELL_CANDIDATES = [
  '/Users/yao/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell',
  '/Users/yao/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
];
const executablePath = SHELL_CANDIDATES.find(existsSync);
if (!executablePath) {
  console.error('找不到 headless chromium，请确认 ms-playwright 缓存目录。');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const settle = (page, ms = 450) => page.waitForTimeout(ms);

async function navTo(page, title) {
  await page.click(`.ent-side-items button[title="${title}"]`);
  await settle(page);
}

async function shoot(page, name) {
  await page.screenshot({ path: resolve(OUT, `${name}.png`), fullPage: false });
  console.log('  ✓', name);
}

async function openWorkBySearch(page, keyword) {
  await navTo(page, '工作记录');
  // 上一轮可能停在某个分桶上，先回到「全部」，否则搜索会被分桶过滤掉。
  await page.locator('[role="tablist"][aria-label="按状态筛选工作记录"] button', { hasText: '全部' }).first().click();
  await settle(page, 250);
  const search = page.locator('input[aria-label="搜索工作记录"]');
  await search.fill(keyword);
  await settle(page, 300);
  await page.locator('.ent-record-title').first().click();
  await settle(page, 550);
}

async function run() {
  const browser = await chromium.launch({ executablePath, args: ['--force-device-scale-factor=1'] });
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 2 });
  const page = await context.newPage();

  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(String(err)));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  // 等待首屏（默认组织架构页）出现侧边栏与内容。
  await page.waitForSelector('.ent-side-items button[title="首页"]', { timeout: 15000 });
  await settle(page, 700);

  console.log('1200×800：');

  // 1. 组织架构（默认落地页）
  await shoot(page, '01-organization');

  // 2. 首页
  await navTo(page, '首页');
  await shoot(page, '02-home');

  // 3. 硅基员工 — 我的（网格）
  await navTo(page, '硅基员工');
  await shoot(page, '03-employees-mine-grid');

  // 4. 硅基员工 — 全部（验证与「我的」是否同一批）
  await page.locator('[role="tablist"][aria-label="员工范围"] button', { hasText: '全部' }).click();
  await settle(page);
  await shoot(page, '04-employees-all');

  // 5. 硅基员工 — 紧凑列表
  await page.locator('button[title="紧凑列表"]').click();
  await settle(page);
  await shoot(page, '05-employees-dense');
  await page.locator('button[title="卡片视图"]').click();
  await settle(page, 200);

  // 6. 员工详情（点第一张卡的「查看技能」→ 详情）
  await page.locator('.ent-emp-grid .ent-emp-card footer button', { hasText: '查看技能' }).first().click();
  await settle(page, 550);
  await shoot(page, '06-employee-detail');

  // 7. 安排工作 — 入口（三模式）
  await navTo(page, '安排工作');
  await shoot(page, '07-arrange-pick');

  // 8. 安排工作 — 对话式
  await page.locator('.ent-mode', { hasText: '对话式' }).click();
  await settle(page, 600);
  await shoot(page, '08-arrange-chat');

  // 9. 安排工作 — 自动编排（返回入口再进）
  await page.locator('.ent-arr-back').first().click();
  await settle(page, 400);
  await page.locator('.ent-mode', { hasText: '自动编排' }).click();
  await settle(page, 600);
  await shoot(page, '09-arrange-auto');

  // 10. 安排工作 — 自己编排
  await page.locator('.ent-arr-back').first().click();
  await settle(page, 400);
  await page.locator('.ent-mode', { hasText: '自己编排' }).click();
  await settle(page, 600);
  await shoot(page, '10-arrange-manual');

  // 11-15. 工作记录各分桶
  await navTo(page, '工作记录');
  const bucketTab = label => page.locator('[role="tablist"][aria-label="按状态筛选工作记录"] button', { hasText: label });
  await shoot(page, '11-records-all');
  for (const [label, file] of [['进行中', '12-records-active'], ['需要我处理', '13-records-mine'], ['已完成', '14-records-done'], ['未完成', '15-records-stopped']]) {
    await bucketTab(label).first().click();
    await settle(page, 350);
    await shoot(page, file);
  }

  // 16-22. 各状态的工作详情
  const works = [
    ['客户周报', '16-work-flow-running'],
    ['会议纪要', '17-work-conversation-running'],
    ['采购合同', '18-work-flow-waiting'],
    ['销售数据', '19-work-flow-completed'],
    ['翻译成英文', '20-work-conversation-completed'],
    ['竞品定价', '21-work-flow-failed'],
    ['资料整理', '22-work-flow-interrupted'],
    ['季度经营', '23-work-draft-pending'],
  ];
  for (const [keyword, file] of works) {
    await openWorkBySearch(page, keyword);
    await shoot(page, file);
    // 下一条 openWorkBySearch 会重新点侧边栏「工作记录」，组件重挂即清空搜索，无需 goBack。
  }

  // 24. 员工技能 — 库
  await navTo(page, '员工技能');
  await settle(page, 400);
  await shoot(page, '24-skills-library');

  // 25. 技能详情
  await page.locator('.skill-card button', { hasText: '查看并调整' }).first().click();
  await settle(page, 550);
  await shoot(page, '25-skill-detail');

  // ── 960×640 窄屏回归（重点页）──
  console.log('960×640（窄屏）：');
  await page.setViewportSize({ width: 960, height: 640 });
  await settle(page, 400);

  await navTo(page, '首页');
  await page.screenshot({ path: resolve(OUT, '90-home-960.png') });
  console.log('  ✓ 90-home-960');

  // 组织架构不在侧边栏，只能用顶栏右上角的切换器（印证文档 1.2）。
  await page.click('button[title="切换到组织架构"]');
  await settle(page, 500);
  await page.screenshot({ path: resolve(OUT, '91-organization-960.png') });
  console.log('  ✓ 91-organization-960');

  await openWorkBySearch(page, '客户周报');
  await page.screenshot({ path: resolve(OUT, '92-work-flow-running-960.png') });
  console.log('  ✓ 92-work-flow-running-960');

  await navTo(page, '硅基员工');
  await page.screenshot({ path: resolve(OUT, '93-employees-960.png') });
  console.log('  ✓ 93-employees-960');

  await browser.close();

  if (errors.length) {
    console.log('\n渲染期控制台报错（前 20 条）：');
    errors.slice(0, 20).forEach(e => console.log('  !', e));
  } else {
    console.log('\n无渲染期控制台报错。');
  }
}

run().catch(err => {
  console.error('截图失败：', err);
  process.exit(1);
});
