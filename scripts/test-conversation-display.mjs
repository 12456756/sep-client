/* global window, document, fetch, navigator, Event */
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import process from 'node:process';
import { log } from 'node:console';
import { chromium } from 'playwright-core';
const origin = process.env.SEP_PREVIEW_ORIGIN ?? 'http://127.0.0.1:5174';
const main = await (await fetch(origin + '/main.tsx')).text();
const fixture = readFileSync(new URL('./fixtures/conversation.html', import.meta.url), 'utf8')
  .replace('__REACT__', main.match(/from "([^"]*react\.js[^"]*)"/)[1])
  .replace('__DOM__', main.match(/from "([^"]*react-dom_client[^"]*)"/)[1])
  .replace('window.cancelMode=', "window.addRawLogs=()=>{task={...task,logs:[{id:'raw-1',message:'Executing tool: ls',timestamp:Date.now(),level:'info'}]};listeners.task?.(task);};window.cancelMode=")
  .replace('React.createElement(WorkTalkDrawer,{workspace,work,onClose:()=>{}})', 'React.createElement(WorkDetailPage,{workspace,workId:work.id})');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const [width, height, reducedMotion] of [[1200, 800, 'no-preference'], [960, 640, 'reduce']]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.route('**/__conversation-display', route => route.fulfill({ contentType: 'text/html', body: fixture }));
    await page.goto(origin + '/__conversation-display');
    await page.getByRole('button', { name: '开始测试' }).click();
    await page.waitForFunction(() => window.workspace?.busy === false && window.workspace?.works.length === 1);
    await page.getByText('第一段', { exact: true }).waitFor({ timeout: 3000 });
    assert.equal(await page.getByRole('dialog').count(), 0, 'conversation is visible without opening a modal');
    assert.equal(await page.locator('.ent-donut').count(), 0, 'chat does not show fabricated percent progress');
    await page.getByRole('textbox', { name: '给员工的下一句话' }).waitFor();
    await page.getByRole('status').filter({ hasText: '正在回复' }).waitFor();
    await page.getByText('工作信息与过程', { exact: true }).click();
    await page.evaluate(() => {
      window.addRawLogs();
      window.emit('tool_execution_start', { toolId: 'ls-one', toolName: 'ls' });
    });
    const activityList = page.getByRole('list', { name: '工作执行记录' });
    await activityList.waitFor();
    assert.equal(await page.getByText('Executing tool: ls', { exact: true }).count(), 0, 'raw logs must not be rendered');
    await page.getByRole('status').filter({ hasText: '当前：正在查看目录' }).waitFor();
    await page.evaluate(() => window.emit('tool_execution_end', { toolId: 'ls-one', toolName: 'ls', success: true }));
    await activityList.getByText('已完成', { exact: true }).waitFor();
    assert.equal(await activityList.locator('li').count(), 1, 'start and end are one row');
    await page.evaluate(() => {
      for (let i = 0; i < 20; i++) {
        window.emit('tool_execution_start', { toolId: `find-${i}`, toolName: 'find' });
        window.emit('tool_execution_end', { toolId: `find-${i}`, toolName: 'find', success: true });
      }
      window.emit('tool_execution_start', { toolId: 'browser-one', toolName: 'mcp__playwright__browser_navigate' });
    });
    await page.getByRole('status').filter({ hasText: '当前：正在打开网页' }).waitFor();
    assert.equal(await activityList.locator('li').count(), 22);
    assert.ok(await activityList.evaluate(el => el.scrollHeight > el.clientHeight && el.clientHeight <= 320), 'process uses one bounded scroll area');
    await activityList.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(tmpdir(), `sep-work-process-${width}.png`) });
    await page.getByText('工作信息与过程', { exact: true }).click();
    const dimensions = await page.evaluate(() => {
      const messages = document.querySelector('.ent-talk').getBoundingClientRect();
      const input = document.querySelector('.ent-ask').getBoundingClientRect();
      return { left: Math.abs(messages.left - input.left), right: Math.abs(messages.right - input.right), height: document.querySelector('.ent-conversation-body').clientHeight };
    });
    assert.ok(dimensions.left < 2 && dimensions.right < 2, `input and messages align: ${JSON.stringify(dimensions)}`);
    assert.ok(dimensions.height >= height * .4, `larger message viewport: ${dimensions.height}`);

    const markdown = '\n\n## 文件清单\n\n| 类型 | 数量 |\n| --- | --- |\n| 文档 | 3 |\n\n```js\nconst count = 3;\n```\n\n[参考](https://example.com) [危险](javascript:alert(1))\n\n<img src=x onerror="window.unsafeMarkdown=true">\n\n![远程图片](https://example.com/tracking.png)';
    await page.evaluate(text => window.emit('text_delta', { text }), markdown);
    await page.getByRole('heading', { name: '文件清单' }).waitFor();
    assert.equal(await page.locator('.ent-markdown table').count(), 1);
    assert.equal(await page.locator('.ent-markdown pre code').innerText(), 'const count = 3;\n');
    assert.equal(await page.getByRole('link', { name: '参考', exact: true }).getAttribute('href'), 'https://example.com');
    assert.equal(await page.locator('.ent-markdown a[href^="javascript:"], .ent-markdown img, .ent-markdown script').count(), 0);
    assert.equal(await page.evaluate(() => window.unsafeMarkdown), undefined);
    await page.screenshot({ path: join(tmpdir(), `sep-conversation-display-${width}.png`) });
    await page.getByRole('button', { name: '复制代码', exact: true }).click();
    assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'), 'const count = 3;\n');
    await page.evaluate(() => window.emit('text_delta', { text: '\n\n' + Array.from({ length: 70 }, (_, i) => `- 说明 ${i}`).join('\n') }));
    const body = page.locator('.ent-conversation-body');
    await page.waitForFunction(() => { const el = document.querySelector('.ent-conversation-body'); return el.scrollHeight > el.clientHeight && el.scrollTop > 0; });
    await body.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
    await page.evaluate(() => window.emit('text_delta', { text: '\n- 新内容' }));
    await page.getByRole('button', { name: '有新内容，回到最新' }).waitFor();
    assert.equal(await body.evaluate(el => el.scrollTop), 0, 'stream must not interrupt reading history');
    await page.getByRole('button', { name: '有新内容，回到最新' }).click();
    assert.ok(await body.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop < 3));
    await page.evaluate(() => window.emit('text_delta', { text: '\n- 继续跟随' }));
    await page.waitForFunction(() => { const el = document.querySelector('.ent-conversation-body'); return el.scrollHeight - el.clientHeight - el.scrollTop < 3; });
    await page.evaluate(() => window.finish());
    await page.getByText('第一段第二段', { exact: true }).waitFor();
    await page.getByRole('status').filter({ hasText: '本轮回复已完成' }).waitFor();
    assert.equal(await page.getByText('没有产出文件', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('heading', { name: /最终产物|产出结果/ }).count(), 0);
    await page.getByRole('button', { name: '复制回答', exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '第一段第二段');
    await page.getByRole('textbox', { name: '给员工的下一句话' }).focus();
    assert.equal(await page.getByRole('textbox', { name: '给员工的下一句话' }).evaluate(el => el === document.activeElement), true);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    assert.deepEqual(errors, []);
    log('PASS conversation display', width, height, 'inline, markdown/security/copy, scroll, final text, focus/layout');
    await page.close();
  }
} finally { await browser.close(); }
