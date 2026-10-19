/* global window, document, navigator */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../', import.meta.url));
const serve = process.argv.includes('--serve');
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { createAvatar } from '@dicebear/core';
import * as toonHead from '@dicebear/toon-head';
import { WorkDetailPage } from './src/pages/enterprise/WorkDetailPage';
import './src/styles/enterprise.css';
const query = new URLSearchParams(location.search);
const count = Number(query.get('count') ?? 6);
const kind = query.get('kind') ?? 'flow';
const status = query.get('status') ?? 'running';
const names = ['\u7206\u54c1\u673a\u4f1a\u8bc4\u4f30\u5e08', '\u4ea7\u54c1\u7ecf\u7406', '\u6587\u6863\u751f\u6210\u4e13\u5bb6', '\u5e02\u573a\u7814\u7a76\u5458', '\u5de5\u4e1a\u8bbe\u8ba1\u5e08', '\u6210\u672c\u5206\u6790\u5e08', 'UNSELECTED'];
const employees = names.map((name, index) => ({
  id: 'employee-' + index, name: query.has('long') ? name + '-LongUnbrokenEmployeeName'.repeat(3) : name,
  roleName: 'Planner', avatar: createAvatar(toonHead, { seed: 'team-' + index }).toDataUri(), avatarAsset: null,
}));
const members = employees.slice(0, count);
const work = {
  id: 'work-a', title: '\u667a\u80fd\u884c\u674e\u7bb1\u4ea7\u54c1\u7b56\u5212', goal: '\u5b8c\u6210\u4ea7\u54c1\u7814\u7a76\u548c\u7b56\u5212\u65b9\u6848', kind,
  workType: { state: 'resolved', kind: kind === 'flow' ? 'arrangement' : 'conversation' },
  status, progress: status === 'completed' ? 100 : 40, currentEmployeeId: members[0]?.id ?? '', currentEmployeeName: members[0]?.name ?? '\u7845\u57fa\u5458\u5de5',
  participants: [...members.map(member => member.id), ...(members[0] ? [members[0].id] : [])],
  steps: members.map((member, index) => ({ id: 'step-' + index, employeeId: member.id, employeeName: member.name,
    title: '\u5de5\u4f5c\u6b65\u9aa4 ' + (index + 1), state: index ? 'pending' : 'running', input: '', output: '', dependsOn: [], skillIds: [] })),
  createdAt: Date.now() - 60000, updatedAt: Date.now(), deliverables: [], timeline: [], messages: [], activities: [],
  sharedContext: { goal: '', confirmedInputs: [], previousResults: [], userNotes: [] }, stopReason: null,
  workDir: query.get('path') ?? 'D:/Work/Enterprise/User/Product planning/Smart suitcase',
};
window.actionCalls = [];
const record = name => () => { window.actionCalls.push(name); };
const workspace = { works: [work], employees, myEmployees: members, busy: false, canGoBack: false, navigate: record('navigate'),
  retryWork: record('retry'), confirmStep: record('confirm'), stopWork: record('stop'), sendMessage: record('send') };
createRoot(document.getElementById('root')).render(
  <div className={'ent-shell' + (query.has('dark') ? ' dark' : '')}><div className='ent-shell-main'>
    <div className='ent-topbar'>\u5de5\u4f5c\u8bb0\u5f55</div>
    <div className='ent-scroll'><WorkDetailPage workspace={workspace} workId='work-a' /></div>
  </div></div>
);
`;
const bundle = await build({
  stdin: { contents: fixture, loader: 'tsx', resolveDir: root },
  bundle: true, write: false, outfile: 'fixture.js', format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': JSON.stringify('development') },
});
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
const css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text;
const server = createServer((request, response) => {
  if (request.url === '/fixture.js') {
    response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    response.end(js);
  } else if (request.url === '/fixture.css') {
    response.setHeader('Content-Type', 'text/css; charset=utf-8');
    response.end(css);
  } else {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'>
      <link rel='stylesheet' href='/fixture.css'><style>
      *,::before,::after{box-sizing:border-box}html,body,#root{height:100%;margin:0}
      body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif}
      button,input,textarea,select{font:inherit}</style></head>
      <body><div id='root'></div><script src='/fixture.js'></script></body></html>`);
  }
});
await new Promise(resolveListening => server.listen(serve ? Number(process.env.PORT ?? 5175) : 0, '127.0.0.1', resolveListening));
const url = 'http://127.0.0.1:' + server.address().port;
const screenshotDir = resolve(tmpdir(), 'sep-work-detail-team');
if (serve) {
  console.log('Isolated work-detail fixture (no backend): ' + url);
} else {
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
    await mkdir(screenshotDir, { recursive: true });
    for (const viewport of [{ width: 1280, height: 800 }, { width: 1440, height: 600 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => {
        window.copiedPaths = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
          writeText: async text => { window.copiedPaths.push(text); },
        } });
      });
      const open = async (query = '') => {
        await page.goto(url + query);
        await page.locator('.ent-wk').waitFor();
      };
      await open();
      assert.equal(await page.getByRole('button', { name: '改一版安排', exact: true }).count(), 0);
      assert.equal(await page.locator('.ent-wk-infobar-meta').count(), 1, 'arrangement facts must form one right-side group');
      const layout = await page.evaluate(() => {
        const summary = document.querySelector('.ent-wk-infobar-summary').getBoundingClientRect();
        const directory = document.querySelector('.ent-wk-infobar-meta .workdir').getBoundingClientRect();
        const team = document.querySelector('.ent-wk-team').getBoundingClientRect();
        const meta = document.querySelector('.ent-wk-infobar-meta').getBoundingClientRect();
        const progress = document.querySelector('.ent-wk-infobar-progress').getBoundingClientRect();
        return { summaryBottom: summary.bottom, directoryTop: directory.top, teamBottom: team.bottom,
          teamRight: team.right, metaTop: meta.top, metaLeft: meta.left, metaBottom: meta.bottom,
          progressWidth: progress.width };
      });
      assert.ok(layout.directoryTop >= layout.summaryBottom, 'directory must occupy a separate second row');
      assert.ok(layout.progressWidth <= 180, 'progress must have a compact, bounded width');
      if (viewport.width > 640) {
        assert.ok(layout.metaLeft > layout.teamRight, 'facts must sit to the right of the employee list');
        assert.ok(Math.abs(layout.teamBottom - layout.metaBottom) <= 1, 'right facts must align with the employee area');
      } else assert.ok(layout.metaTop >= layout.teamBottom, 'mobile facts must wrap below the employee list');
      const list = page.locator('.ent-wk-team-list');
      assert.equal(await list.count(), 1, 'arrangements must have one independent employee list');
      assert.equal(await list.locator('li').count(), 6, 'show all selected employees, without duplicates');
      assert.equal(await list.locator('img').count(), 6, 'each employee must keep their avatar');
      await page.waitForFunction(() => [...document.querySelectorAll('.ent-wk-team-list img')].slice(0, 3)
        .every(image => image.complete && image.naturalWidth > 0));
      assert.equal(await list.getByText('UNSELECTED', { exact: true }).count(), 0);
      const initial = await list.evaluate(element => ({ height: element.clientHeight, scrollHeight: element.scrollHeight,
        top: element.getBoundingClientRect().top, scrollTop: element.scrollTop }));
      assert.ok(initial.scrollHeight > initial.height, 'six employees must scroll inside a fixed-height list');
      assert.equal(await list.evaluate(element => {
        const box = element.getBoundingClientRect();
        return [...element.children].filter(child => {
          const row = child.getBoundingClientRect();
          return row.top >= box.top && row.bottom <= box.bottom + 1;
        }).length;
      }), 2, 'exactly two employee rows must fit before scrolling');
      const defaultPath = 'D:/Work/Enterprise/User/Product planning/Smart suitcase';
      const pathLabel = page.locator('.ent-wk-path > span');
      assert.equal(await pathLabel.innerText(), '\u2026/Product planning/Smart suitcase');
      assert.equal(await pathLabel.getAttribute('title'), defaultPath, 'hover must retain the full path');
      await page.getByRole('button', { name: '\u590d\u5236\u5de5\u4f5c\u76ee\u5f55', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.copiedPaths), [defaultPath], 'copy must use the complete path');
      const heading = page.locator('.ent-wk-team > strong');
      assert.equal(await heading.innerText(), '6 \u4f4d\u540c\u4e8b\u534f\u4f5c');
      const headingBox = await heading.boundingBox();
      assert.ok(headingBox.y + headingBox.height <= initial.top, 'employee count belongs above the list');
      const pageTop = await page.locator('.ent-scroll').evaluate(element => element.scrollTop);
      await list.hover();
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(200);
      assert.ok(await list.evaluate(element => element.scrollTop) > 0);
      assert.equal(await page.locator('.ent-scroll').evaluate(element => element.scrollTop), pageTop,
        'employee scrolling must not move the surrounding work page');
      const last = await list.locator('li').last().boundingBox();
      await page.waitForFunction(() => {
        const image = document.querySelector('.ent-wk-team-list li:last-child img');
        return image.complete && image.naturalWidth > 0;
      });
      const box = await list.boundingBox();
      assert.ok(last.y >= box.y && last.y + last.height <= box.y + box.height + 1, 'last employee must be reachable');
      if (viewport.width < 640) {
        assert.equal(await page.locator('.ent-wk-infobar-sep').isVisible(), false, 'mobile must not leave an orphaned separator');
      }
      await list.focus();
      await page.keyboard.press('Home');
      await page.waitForTimeout(200);
      assert.equal(await list.evaluate(element => element.scrollTop), 0, 'list must be keyboard-scrollable');
      await page.screenshot({ path: resolve(screenshotDir, viewport.width + '-' + viewport.height + '.png') });
      for (const count of [1, 3]) {
        await open('?count=' + count);
        assert.equal(await list.locator('li').count(), count);
        assert.equal(await list.evaluate(element => element.clientHeight), initial.height, 'height must not change with employee count');
        if (count === 3) await page.screenshot({ path: resolve(screenshotDir, viewport.width + '-three.png') });
      }
      await open('?long=1&dark=1');
      assert.ok(await list.evaluate(element => element.scrollWidth <= element.clientWidth), 'long names must not overflow horizontally');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'page must fit the viewport');
      const name = list.locator('.ent-wk-team-name').first();
      assert.ok(await name.evaluate(element => element.scrollHeight <= element.clientHeight), 'long names must be readable, not clipped');
      await page.screenshot({ path: resolve(screenshotDir, viewport.width + '-long-dark.png') });
      assert.deepEqual(await page.evaluate(() => window.actionCalls), [], 'employee display must not invoke task actions');
      const paths = [
        ['C:\\Users\\Owner\\Documents\\Product planning\\Smart suitcase\\', '\u2026\\Product planning\\Smart suitcase'],
        ['/home/user/Work/research/report', '\u2026/research/report'],
        ['\\\\server\\share\\department\\project', '\u2026\\department\\project'],
        ['research/report', 'research/report'], ['C:\\', 'C:\\'], ['/', '/'],
        ['/home/user/' + 'LongProjectDirectory'.repeat(8) + '/' + 'LongTaskDirectory'.repeat(8),
          '\u2026/' + 'LongProjectDirectory'.repeat(8) + '/' + 'LongTaskDirectory'.repeat(8)],
      ];
      for (const [fullPath, shortPath] of paths) {
        await open('?path=' + encodeURIComponent(fullPath));
        assert.equal(await pathLabel.innerText(), shortPath);
        assert.equal(await pathLabel.getAttribute('title'), fullPath);
        await page.getByRole('button', { name: '\u590d\u5236\u5de5\u4f5c\u76ee\u5f55', exact: true }).click();
        assert.deepEqual(await page.evaluate(() => window.copiedPaths), [fullPath]);
        assert.ok(await page.locator('.ent-wk-path').evaluate(element => {
          const label = element.querySelector('span');
          const button = element.querySelector('button');
          const box = element.getBoundingClientRect();
          return box.width <= element.parentElement.clientWidth && label.clientWidth > 0
            && button.getBoundingClientRect().right <= box.right + 1;
        }), 'path width must be bounded while keeping the copy button visible');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
      }
      await page.screenshot({ path: resolve(screenshotDir, viewport.width + '-long-path.png') });
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      for (const status of ['completed', 'failed', 'paused']) {
        await open('?count=3&status=' + status);
        const progress = await page.locator('.ent-wk-infobar-progress .ent-bar').evaluate(element => {
          const fill = window.getComputedStyle(element.querySelector('i'));
          const sample = document.createElement('span');
          sample.style.color = 'var(--ent-ready-solid)';
          element.append(sample);
          const readyColor = window.getComputedStyle(sample).color;
          sample.remove();
          return { background: fill.backgroundImage, animation: fill.animationName,
            color: fill.backgroundColor, readyColor, text: element.textContent };
        });
        assert.equal(progress.animation, 'none', 'terminal tasks must never show an animated progress fill');
        if (status === 'completed') {
          assert.equal(progress.background, 'none', 'completed work must use a solid progress fill');
          assert.equal(progress.color, progress.readyColor, 'completed work must be green');
          assert.equal(progress.text, '100%');
          await page.screenshot({ path: resolve(screenshotDir, viewport.width + '-completed.png'), animations: 'disabled' });
        } else assert.notEqual(progress.color, progress.readyColor, 'failed or paused work must not look completed');
      }
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await open('?path=');
      assert.equal(await page.locator('.ent-wk-path').count(), 0, 'default workspace text must remain without a copy button');
      await open('?kind=conversation&count=1');
      assert.equal(await list.count(), 0, 'conversation header must keep its existing single-employee layout');
      assert.equal(await page.locator('.ent-wk-infobar-who').count(), 1);
      assert.equal(await page.locator('.ent-wk-infobar-meta').count(), 0, 'conversation metadata layout must stay unchanged');
      await open('?count=0');
      assert.equal(await list.count(), 0, 'missing employee data must retain the existing fallback');
      assert.deepEqual(errors, []);
      console.log('PASS: selected employees, fixed-height scrolling, long names and conversation at ' + viewport.width + 'x' + viewport.height);
      await page.close();
    }
    console.log('Screenshots: ' + screenshotDir);
  } finally {
    await browser?.close();
    await new Promise(resolveClosed => server.close(resolveClosed));
  }
}
