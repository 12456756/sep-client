/* global window, document */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const executablePath = process.env.SEP_PREVIEW_BROWSER ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(path => existsSync(path));
assert.ok(executablePath, 'Set SEP_PREVIEW_BROWSER to an installed Chromium executable');
const browser = await chromium.launch({ executablePath, headless: true });
const outputDir = join(process.cwd(), 'output', 'playwright');
mkdirSync(outputDir, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.SEP_PREVIEW_URL ?? 'http://127.0.0.1:5174/?preview=workspace');
  await page.locator('.ent-shell').waitFor();
  assert.equal(await page.evaluate(() => 'electronAPI' in window), false);
  const recordsSource = await (await page.request.get(new URL('/pages/enterprise/WorkRecordsPage.tsx', page.url()).href)).text();
  const mainSource = await (await page.request.get(new URL('/main.tsx', page.url()).href)).text();
  const reactPath = recordsSource.match(/from "([^"]*\/react\.js[^"]*)"/)?.[1];
  const domPath = mainSource.match(/from "([^"]*\/react-dom_client\.js[^"]*)"/)?.[1];
  assert.ok(reactPath && domPath, 'Vite must serve the React dependency modules');

  // Test-only IPC fixtures exercise the real hook and page, not production preview data.
  await page.evaluate(async ({ reactPath, domPath }) => {
    const { default: React } = await import(reactPath);
    const { createRoot } = (await import(domPath)).default;
    const { WorkRecordsPage } = await import('/pages/enterprise/WorkRecordsPage.tsx');
    const { useEnterpriseWorkspace } = await import('/features/enterprise/useEnterpriseWorkspace.ts');
    const task = (id, title, status, kind) => ({
      id, title, prompt: '客户资料', status, workDir: null, createdAt: 1,
      startedAt: 2, completedAt: status === 'completed' ? 3 : null,
      error: null, files: [], logs: [], ownerId: 'member-a', ownerEnterpriseId: 'enterprise-a',
      subscriptionId: 'employee-a', activeRunId: null,
      workType: kind ? { state: 'resolved', kind } : { state: 'unavailable' },
    });
    let tasks = [
      task('conversation', '客户资料会话', 'completed', 'conversation'),
      task('arrangement', '客户资料编排-' + 'verylongunbrokentitle'.repeat(8), 'completed', 'arrangement'),
      task('running', '正在整理客户资料', 'running', 'conversation'),
      task('waiting', '等待确认客户资料', 'waiting_approval', 'arrangement'),
      task('unknown', '类型损坏的客户资料', 'paused', null),
    ];
    tasks[1].activeRunId = 'run-arrangement';
    const listeners = { task: new Set(), list: new Set(), pi: new Set() };
    const subscribe = kind => callback => { listeners[kind].add(callback); return () => listeners[kind].delete(callback); };
    const reads = {};
    const planReads = {};
    const pending = {};
    let earlyCommitted = false;
    const plan = id => ({
      id, schemaVersion: 1, sourceDraftId: 'draft-' + id, sourceDraftRevision: 1,
      owner: { memberId: 'member-a', enterpriseId: 'enterprise-a' }, mode: 'manual',
      title: '客户资料编排', goal: '客户资料', conversation: null,
      nodes: [{ id: 'node-a', subscriptionId: 'employee-a', title: '读取已保存的编排计划',
        instruction: '整理资料', expectedOutput: '整理结果', dependsOn: [], requiresUserConfirmation: false }],
      workspace: { mode: 'shared', path: null }, permissions: {}, confirmedInputs: [], planHash: 'hash', createdAt: 1,
    });
    window.electronAPI = {
      getAllTasks: async () => ({ success: true, tasks }),
      getTask: async id => {
        reads[id] = (reads[id] ?? 0) + 1;
        if (id === 'early') return new Promise(resolve => { pending[id] = resolve; });
        return { success: true, task: tasks.find(item => item.id === id) };
      },
      getTaskMessages: async () => ({ success: true, messages: [] }),
      getArrangementPlan: async id => {
        planReads[id] = (planReads[id] ?? 0) + 1;
        return { success: true, plan: id === 'arrangement' || (id === 'early' && earlyCommitted) ? plan(id) : null };
      },
      getTaskTimeline: async () => { throw new Error('Timeline deliberately unavailable'); },
      getEnterpriseOrganization: async () => ({ success: false }),
      listSkillLibrary: async () => ({ success: true, data: [] }),
      onTaskUpdated: subscribe('task'), onTaskListUpdated: subscribe('list'), onPiEvent: subscribe('pi'),
    };
    const element = React.createElement;
    window.recordTest = {
      reads,
      planReads,
      emitRaw() {
        const raw = tasks.map(item => { const copy = { ...item }; delete copy.workType; return copy; });
        listeners.list.forEach(callback => callback(raw));
        listeners.task.forEach(callback => callback({ ...raw[0], title: '客户资料会话实时更新' }));
      },
      emitEarly() {
        const early = { ...task('early', '新建编排', 'pending', 'arrangement'), workType: undefined };
        tasks = [...tasks, early];
        listeners.task.forEach(callback => callback(early));
      },
      finishEarly() {
        earlyCommitted = true;
        pending.early({ success: true, task: { ...tasks.find(item => item.id === 'early'), workType: { state: 'resolved', kind: 'arrangement' } } });
      },
      repairUnknown() {
        tasks = tasks.map(item => item.id === 'unknown' ? { ...item, workType: { state: 'resolved', kind: 'conversation' } } : item);
      },
    };
    function Harness() {
      const workspace = useEnterpriseWorkspace({ userId: 'member-a', userName: '测试', enterpriseId: 'enterprise-a', enterpriseName: '测试', instances: [], employeeStatuses: [] });
      React.useEffect(() => { workspace.navigate({ name: 'records' }); }, [workspace.navigate]);
      window.recordTest.workspace = workspace;
      return element('div', { className: 'ent-shell' }, element('main', { className: 'ent-shell-main' },
        element('div', { className: 'ent-scroll' }, workspace.route.name === 'work'
          ? element('button', { onClick: workspace.goBack }, '返回记录')
          : element(WorkRecordsPage, { workspace }))));
    }
    document.getElementById('root').style.display = 'none';
    const root = document.createElement('div');
    root.id = 'work-record-test-root';
    document.body.append(root);
    createRoot(root).render(element(Harness));
  }, { reactPath, domPath });

  const status = page.getByRole('group', { name: '按状态筛选工作记录' });
  const type = page.getByRole('group', { name: '按类型筛选工作记录' });
  const cards = page.locator('.ent-record');
  await status.getByRole('button', { name: /需要我处理/ }).waitFor();
  await page.waitForFunction(() => window.recordTest.workspace.works.length === 5);
  await page.waitForFunction(() => window.recordTest.workspace.works.find(work => work.id === 'arrangement')?.steps[0]?.title === '读取已保存的编排计划');
  assert.equal(await cards.count(), 1, 'First entry defaults to needs-me');
  await status.getByRole('button', { name: /^全部/ }).click();
  assert.equal(await cards.count(), 5);
  await type.getByRole('button', { name: /^编排/ }).click();
  assert.equal(await cards.count(), 2);
  await status.getByRole('button', { name: /^已完成/ }).click();
  assert.equal(await cards.count(), 1);
  const search = page.getByRole('searchbox', { name: '搜索工作记录' });
  await search.fill('客户资料');
  assert.match(await type.getByRole('button', { name: /^会话/ }).innerText(), /1/);
  await cards.getByRole('button', { name: '查看完成情况' }).click();
  await page.getByRole('button', { name: '返回记录' }).click();
  assert.equal(await search.inputValue(), '客户资料');
  assert.equal(await type.getByRole('button', { name: /^编排/ }).getAttribute('aria-pressed'), 'true');
  assert.equal(await status.getByRole('button', { name: /^已完成/ }).getAttribute('aria-pressed'), 'true');
  await page.evaluate(() => window.recordTest.emitRaw());
  await page.waitForFunction(() => window.recordTest.workspace.works.find(work => work.id === 'conversation')?.title.endsWith('实时更新'));
  assert.equal(await cards.count(), 1, 'Raw list/single events must retain queried classifications');

  await search.fill('不存在的关键词');
  await page.getByText('没有符合条件的工作记录', { exact: true }).waitFor();
  await page.getByRole('button', { name: '重置筛选' }).click();
  assert.equal(await search.inputValue(), '');
  assert.equal(await cards.count(), 5);
  await page.evaluate(() => window.recordTest.emitEarly());
  await page.locator('.ent-record-type.loading').waitFor();
  assert.equal(await page.evaluate(() => window.recordTest.reads.early), 1);
  assert.equal(await page.evaluate(() => window.recordTest.planReads.early ?? 0), 0, 'Do not read a new plan before classification confirms the creation commit');
  assert.equal(await page.locator('.ent-record-type.loading').innerText(), '类型加载中');
  await type.getByRole('button', { name: /^会话/ }).click();
  assert.equal(await cards.count(), 2, 'Unresolved early arrangement must never enter conversation results');
  await page.evaluate(() => window.recordTest.finishEarly());
  await page.waitForFunction(() => window.recordTest.workspace.works.find(work => work.id === 'early')?.workType.kind === 'arrangement');
  await page.waitForFunction(() => window.recordTest.workspace.works.find(work => work.id === 'early')?.steps[0]?.title === '读取已保存的编排计划');
  await type.getByRole('button', { name: /^全部/ }).click();

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `No horizontal overflow at ${width}px`);
    assert.equal(await page.locator('.ent-record-type.resolved').count(), 5);
    await page.screenshot({ path: join(outputDir, `work-records-${width}.png`), fullPage: true });
  }
  await page.evaluate(() => window.recordTest.repairUnknown());
  await page.getByRole('button', { name: '重新读取类型' }).click();
  await page.waitForFunction(() => window.recordTest.workspace.works.find(work => work.id === 'unknown')?.workType.kind === 'conversation');
  assert.equal(await page.locator('.ent-record-type.unavailable').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: filters/counts, reset, detail return, raw events, early creation, plan/timeline isolation, type retry and desktop/narrow layout');
} finally {
  await browser.close();
}
