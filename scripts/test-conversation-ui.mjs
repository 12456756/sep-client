/* global window, document, fetch */
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
const html = readFileSync(new URL('./fixtures/conversation.html', import.meta.url), 'utf8')
 .replace('__REACT__', main.match(/from "([^"]*react\.js[^"]*)"/)[1])
 .replace('__DOM__', main.match(/from "([^"]*react-dom_client[^"]*)"/)[1]);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
 for (const [width,height,reducedMotion] of [[1200,800,'no-preference'],[960,640,'reduce']]) {
  const page = await browser.newPage({ viewport: {width,height}, reducedMotion });
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.clock.install();
  await page.route('**/__conversation-test',r=>r.fulfill({contentType:'text/html',body:html}));
  await page.goto(origin+'/__conversation-test');
  await page.getByRole('button',{name:'开始测试'}).waitFor();
  await page.evaluate(()=>{window.deferMessages=true;});
  await page.getByRole('button',{name:'开始测试'}).click();
  await page.waitForFunction(()=>window.workspace?.busy===false && window.workspace?.works.length===1);
  await page.evaluate(()=>{window.deferMessages=false;window.releaseInitial();});
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(()=>window.workspace.works.length),1,'stale initial list must not replace task pushes');
  assert.equal(await page.evaluate(()=>window.createdGoal),'请整理资料');
  assert.equal(await page.locator('.ent-say.user p').innerText(),'请整理资料');
  assert.equal(await page.locator('.ent-say:not(.user) p').textContent(),'第一段','early delta must survive start response');
  await page.evaluate(()=>window.emit('text_delta',{text:'第二段'}));
  await page.getByText('第一段第二段',{exact:true}).waitFor();
  await page.evaluate(()=>window.emit('agent_end',{willRetry:true}));
  assert.equal(await page.getByText('第一段第二段',{exact:true}).count(),1);
  await page.evaluate(()=>window.finish());
  await page.waitForFunction(()=>document.querySelector('[data-testid="status"]').textContent==='completed');
  assert.equal(await page.getByText('第一段第二段',{exact:true}).count(),1);
  await page.evaluate(()=>window.releaseOldHistory());
  await page.waitForTimeout(50);
  assert.equal(await page.getByText('第一段第二段',{exact:true}).count(),1,'stale history must not replace final answer');
  assert.equal(await page.getByRole('combobox',{name:'换一位员工接手'}).isDisabled(),false);
  await page.getByRole('textbox',{name:'给员工的下一句话'}).fill('继续分析');
  await page.getByRole('textbox',{name:'给员工的下一句话'}).press('Control+Enter');
  await page.waitForFunction(()=>window.continued?.prompt==='继续分析');
  assert.equal(await page.locator('.ent-say.user p').filter({hasText:'继续分析'}).count(),1,'user bubble must appear before IPC resolves');
  await page.evaluate(()=>window.admitContinue());
  await page.waitForTimeout(80);
  assert.equal(await page.locator('.ent-say.user p').filter({hasText:'继续分析'}).count(),1,'early history must retain pending bubble');
  await page.evaluate(()=>window.resolveContinue(true));
  await page.waitForFunction(()=>window.workspace.busy===false);
  await page.evaluate(()=>window.settleContinue());
  await page.waitForFunction(()=>window.workspace.works[0].status==='completed');
  assert.equal(await page.locator('.ent-say.user p').filter({hasText:'继续分析'}).count(),1,'persisted prompt must replace optimistic bubble');
  // Repeating the same text is a distinct turn, not a duplicate of old history.
  await page.getByRole('textbox',{name:'给员工的下一句话'}).fill('继续分析');
  await page.getByRole('textbox',{name:'给员工的下一句话'}).press('Control+Enter');
  await page.waitForFunction(()=>window.workspace.busy===true);
  assert.equal(await page.locator('.ent-say.user p').filter({hasText:'继续分析'}).count(),2);
  await page.evaluate(()=>window.admitContinue());
  await page.waitForTimeout(80);
  assert.equal(await page.locator('.ent-say.user p').filter({hasText:'继续分析'}).count(),2);
  await page.evaluate(()=>window.resolveContinue(true));
  await page.waitForFunction(()=>window.workspace.busy===false);
  await page.evaluate(()=>window.settleContinue());
  await page.waitForFunction(()=>window.workspace.works[0].status==='completed');
  assert.equal(await page.locator('.ent-say.user p').filter({hasText:'继续分析'}).count(),2);
  for(const outcome of [false,'throw']) {
   await page.getByRole('textbox',{name:'给员工的下一句话'}).fill('这条发送失败');
   await page.getByRole('textbox',{name:'给员工的下一句话'}).press('Control+Enter');
   await page.waitForFunction(()=>window.workspace.busy===true);
   assert.equal(await page.getByText('这条发送失败',{exact:true}).count(),1);
   await page.evaluate(value=>window.resolveContinue(value),outcome);
   await page.waitForFunction(()=>window.workspace.busy===false);
   assert.equal(await page.getByText('这条发送失败',{exact:true}).count(),0,'failed send rolls back only its own bubble');
   await page.getByRole('alert').filter({hasText:outcome===false?'模拟发送失败':'模拟发送异常'}).waitFor();
   assert.equal(await page.locator('.ent-say.user p').filter({hasText:'继续分析'}).count(),2);
   if(outcome===false) {
    await page.clock.fastForward(3000);
    assert.ok(await page.evaluate(()=>window.workspace.error),'notification stays visible long enough to read');
   } else {
    await page.clock.fastForward(2100);
    assert.equal(await page.evaluate(()=>window.workspace.error),'模拟发送异常','old timer must not dismiss a newer notification');
    await page.clock.fastForward(3000);
    await page.waitForFunction(()=>window.workspace.error===null);
    assert.equal(await page.getByRole('alert').count(),0,'notification dismisses automatically without a click');
   }
  }
  await page.getByRole('textbox',{name:'给员工的下一句话'}).fill('准备终止');
  await page.getByRole('textbox',{name:'给员工的下一句话'}).press('Control+Enter');
  await page.waitForFunction(()=>window.workspace.busy===true);
  await page.evaluate(()=>{window.admitContinue();window.resolveContinue(true);});
  await page.waitForFunction(()=>window.workspace.busy===false);

  await page.getByRole('button',{name:'终止',exact:true}).click();
  await page.getByPlaceholder('终止原因（可留空）').fill('资料需要更正');
  await page.getByRole('button',{name:'确认终止',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'正在终止…'}).isDisabled(),true);
  await page.evaluate(()=>window.resolveCancel(false));
  await page.getByRole('alert').filter({hasText:'模拟终止失败'}).waitFor();
  assert.equal(await page.getByPlaceholder('终止原因（可留空）').inputValue(),'资料需要更正');
  await page.screenshot({path:join(tmpdir(),`sep-notice-${width}.png`)});
  await page.clock.fastForward(5100);
  await page.waitForFunction(()=>window.workspace.error===null);
  assert.equal(await page.getByPlaceholder('终止原因（可留空）').inputValue(),'资料需要更正','auto-dismiss does not close confirmation or clear input');
  await page.getByRole('button',{name:'确认终止',exact:true}).click();
  await page.evaluate(()=>window.resolveCancel(true));
  await page.waitForFunction(()=>document.querySelector('[data-testid="status"]').textContent==='paused');
  assert.deepEqual(await page.evaluate(()=>window.cancelInput),{taskId:'work-1',reason:'资料需要更正'});
  await page.getByRole('textbox',{name:'给员工的下一句话'}).focus();
  assert.equal(await page.getByRole('textbox',{name:'给员工的下一句话'}).evaluate(el=>el===document.activeElement),true);
  const bounds=await page.getByRole('dialog').boundingBox();
  assert.ok(bounds.x>=0 && bounds.x+bounds.width<=width+1);
  await page.screenshot({path:join(tmpdir(),`sep-conversation-${width}.png`)});
  await page.evaluate(()=>window.workspace.deleteWork('work-1'));
  await page.getByRole('button',{name:'开始测试'}).waitFor();
  assert.equal(await page.evaluate(()=>window.deletedTaskId),'work-1');
  assert.equal(await page.evaluate(()=>window.workspace.works.length),0,'successful deletion removes the stopped record');
  assert.deepEqual(errors,[]);
  log('PASS',width,'raw goal, early/multiple deltas, retry retention, final history/status, optimistic send/early history/deduplication/repeated text/failure rollback, cancellation busy/error/reason, notification auto-dismiss/reset, stopped record deletion, focus/layout');
  await page.close();
 }
} finally { await browser.close(); }
