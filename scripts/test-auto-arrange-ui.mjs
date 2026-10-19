/* global window, document, fetch, requestAnimationFrame */
import { URL } from 'node:url';
// Controlled IPC contract fixtures, real pages/hooks. Does not contact the platform or run tools.
import { readFileSync } from 'node:fs';
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
const html = readFileSync(new URL('./fixtures/auto-arrange.html', import.meta.url), 'utf8').replace('__REACT__',reactUrl).replace('__DOM__',domUrl);
const browser = await chromium.launch({channel:'msedge', headless:true});
const failures = [];
try {
 for (const [width,height,reducedMotion] of [[1200,800,'no-preference'],[960,640,'reduce']]) {
  const page = await browser.newPage({viewport:{width,height}, reducedMotion});
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/__auto-arrange-test',r=>r.fulfill({contentType:'text/html',body:html}));
  const reset = async (scenario) => {
   await page.goto(origin+'/__auto-arrange-test');
   await page.getByRole('textbox',{name:'工作目标',exact:true}).waitFor();
   await page.evaluate(s=>{window.scenario=s;},scenario);
   await page.getByRole('textbox',{name:'工作目标',exact:true}).fill('分析市场并生成报告');
   await page.getByRole('combobox',{name:'模型',exact:true}).selectOption('model');
  };
  const check = async (name, fn) => { try {await fn();log('PASS',width,name);} catch(e) {log('DIAGNOSTIC',name,await page.evaluate(()=>({text:document.body.innerText,route:window.workspace?.route,works:window.workspace?.works,counts:window.counts})),errors);failures.push(width+' '+name+': '+e.message);await page.screenshot({path:join(tmpdir(),'sep-auto-failure-'+width+'-'+name+'.png')});} };
  await check('creation-lock',async()=>{
   await reset('slow-create');
   await page.getByRole('button',{name:'开始自动编排'}).click();
   assert.equal(await page.getByRole('button',{name:/开始自动编排|正在/}).first().isDisabled(),true);
   assert.equal(await page.evaluate(()=>window.counts.create),1);
  });
  await check('early-completion',async()=>{
   await reset('early');await page.getByRole('button',{name:'开始自动编排'}).click();
   await page.waitForFunction(()=>window.planResponded === true);
   await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
   await page.getByRole('button',{name:'确认并开始工作',exact:true}).waitFor({timeout:15000});
   assert.equal(await page.locator('.animate-spin').count(),0);
  });
  await check('failure-retry',async()=>{
   await reset('normal');await page.getByRole('button',{name:'开始自动编排'}).click();
   await page.getByText('正在分析你的工作目标',{exact:true}).waitFor();
   await page.evaluate(()=>window.emit('arrangement_planning_failed',{message:'测试规划失败'}));
   await page.getByRole('alert').filter({hasText:'测试规划失败'}).waitFor({timeout:3000});
   await page.getByRole('button',{name:'重新编排',exact:true}).click();
   await page.getByRole('textbox',{name:'工作目标',exact:true}).fill('分析市场并生成报告');
   await page.getByRole('combobox',{name:'模型',exact:true}).selectOption('model');
  });
  await check('selection-to-execution',async()=>{
   await reset('normal');await page.getByRole('button',{name:'开始自动编排'}).click();
   await page.getByText('正在分析你的工作目标',{exact:true}).waitFor();
   await page.evaluate(()=>window.emit('arrangement_employee_considering',{subscriptionId:'sub-spare'}));
   await page.getByText('正在匹配最适合完成任务的员工……',{exact:true}).waitFor();
   assert.equal(await page.locator('.ent-aa-team, .ent-aa-card').count(),0,'no employee identities before the result');
   assert.equal(await page.locator('.ent-aa-strip li').count(),4);
   assert.equal(await page.getByRole('button',{name:'确认并开始工作',exact:true}).count(),0);
   await page.screenshot({path:join(tmpdir(),'sep-auto-selecting-'+width+'.png')});
   await page.evaluate(()=>window.complete());
   await page.getByRole('group',{name:'已选中的员工'}).waitFor();
   assert.equal(await page.locator('.ent-aa-team-member').count(),2);
   assert.equal(await page.locator('.ent-aa-team').getByText('候补员工',{exact:true}).count(),0);
   await page.waitForFunction(()=>document.querySelector('.ent-aa-flow .ent-aa-link.in'));
   await page.getByRole('button',{name:'确认并开始工作',exact:true}).waitFor();
   assert.equal(await page.locator('.ent-flowcard.in').count(),2);
   assert.equal(await page.locator('.ent-aa-strip li.done').count(),3);
   assert.equal(await page.evaluate(()=>window.counts.start),0,'animation must never execute work');
   assert.equal(await page.locator('.ent-aa-link-line').first().evaluate(el=>window.getComputedStyle(el).animationName)==='none',reducedMotion==='reduce');
   await page.screenshot({path:join(tmpdir(),'sep-auto-ready-'+width+'.png'),fullPage:true});
   assert.equal(await page.locator('.animate-spin').count(),0,'unselected employees must stop spinning');
   await page.getByRole('button',{name:'确认并开始工作',exact:true}).click();
   await page.locator('.ent-wk').waitFor({timeout:4000});
   await page.getByText('2 位同事协作',{exact:true}).waitFor();
   await page.evaluate(()=>window.nodeEvent('arrangement_node_started','node-a'));
   await page.getByRole('status').filter({hasText:'当前：正在市场调研'}).waitFor();
   await page.evaluate(()=>{window.nodeEvent('arrangement_node_completed','node-a');window.nodeEvent('arrangement_state_changed','node-a','completed');window.nodeEvent('arrangement_node_started','node-b');});
   await page.getByText('50%',{exact:true}).first().waitFor();
   await page.getByRole('list',{name:'工作执行记录'}).locator('li.completed').filter({hasText:'市场调研'}).waitFor({timeout:3000});
   assert.deepEqual(await page.evaluate(()=>window.workspace.works[0].steps.map(s=>s.state)),['done','running']);
   await page.waitForFunction(()=>{
    const bar=document.querySelector('.ent-bar > span > i');
    return Math.abs(bar.getBoundingClientRect().width/bar.parentElement.getBoundingClientRect().width-.5)<.01;
   });
   await page.waitForFunction(()=>{
    const circle=document.querySelector('.ent-donut svg circle:nth-of-type(2)');
    return Math.abs(Number.parseFloat(window.getComputedStyle(circle).strokeDashoffset)-Math.PI*59/2)<1;
   });
   await page.screenshot({path:join(tmpdir(),'sep-auto-executing-'+width+'.png'),fullPage:true});
   await page.evaluate(()=>window.finish());
   await page.getByText('工作已完成',{exact:true}).waitFor();
   assert.equal(await page.locator('.ent-wk-activity.running').count(),0);
   assert.equal(await page.locator('.ent-bar > span > i').evaluate(el=>window.getComputedStyle(el).animationName),'none','completed progress must stop animating');
   await page.getByText('report.md',{exact:true}).first().waitFor();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
   await page.waitForFunction(()=>{
    const bar=document.querySelector('.ent-bar > span > i');
    return Math.abs(bar.getBoundingClientRect().width/bar.parentElement.getBoundingClientRect().width-1)<.01;
   });
   await page.screenshot({path:join(tmpdir(),'sep-auto-completed-'+width+'.png'),fullPage:true});
  });
  await check('cancel-and-stale-events',async()=>{
   await reset('normal');await page.getByRole('button',{name:'开始自动编排'}).click();
   await page.getByRole('button',{name:'取消编排'}).waitFor();
   await page.evaluate(()=>window.staleEvent());
   assert.equal(await page.getByRole('alert').count(),0);
   await page.getByRole('button',{name:'取消编排'}).click();
   await page.getByRole('button',{name:'重新编排',exact:true}).waitFor();
   assert.equal(await page.getByRole('button',{name:'确认并开始工作',exact:true}).count(),0);
   assert.equal(await page.locator('.animate-spin').count(),0);
  });
  await check('restart-restores-animation',async()=>{
   await reset('early');await page.getByRole('button',{name:'开始自动编排'}).click();
   const restart=page.getByRole('button',{name:'重新编排',exact:true});
   await restart.waitFor();await restart.focus();await page.keyboard.press('Enter');
   await page.getByRole('textbox',{name:'工作目标',exact:true}).waitFor();
   assert.equal(await page.locator('.ent-aa-flow').count(),0);
   await page.evaluate(()=>{window.scenario='normal';});
   await page.getByRole('combobox',{name:'模型',exact:true}).selectOption('model');
   await page.getByRole('button',{name:'开始自动编排'}).click();
   await page.getByText('正在分析你的工作目标',{exact:true}).waitFor();
   await page.getByText('正在匹配最适合完成任务的员工……',{exact:true}).waitFor();
   assert.equal(await page.locator('.ent-aa-team-member').count(),0);
   assert.equal(await page.getByRole('button',{name:'确认并开始工作',exact:true}).count(),0);
   assert.equal(await page.evaluate(()=>window.counts.start),0);
  });
  await check('preflight-retry-keeps-revision',async()=>{
   await reset('preflight-retry');await page.getByRole('button',{name:'开始自动编排'}).click();
   await page.getByText('正在分析你的工作目标',{exact:true}).waitFor();
   await page.evaluate(()=>window.complete());
   await page.getByRole('button',{name:'确认并开始工作',exact:true}).click();
   await page.getByText('测试预检失败',{exact:true}).waitFor();
   assert.equal(await page.evaluate(()=>window.counts.start),0);
   await page.getByRole('button',{name:'确认并开始工作',exact:true}).click();
   await page.locator('.ent-wk').waitFor();
   assert.equal(await page.evaluate(()=>window.counts.start),1);
  });
  await check('read-only-plan-and-confirm-lock',async()=>{
   await reset('slow-start');await page.getByRole('button',{name:'开始自动编排'}).click();
   await page.getByText('正在分析你的工作目标',{exact:true}).waitFor();
   await page.evaluate(()=>window.complete());
   await page.getByRole('button',{name:'确认并开始工作',exact:true}).waitFor();
   assert.equal(await page.getByText('编辑编排草稿',{exact:true}).count(),0);
   assert.equal(await page.getByRole('button',{name:'保存步骤修改',exact:true}).count(),0);
   assert.equal(await page.getByRole('textbox').count(),0);
   assert.equal(await page.locator('.ent-flowcard-output').count(),2);
   await page.getByText('事实清单',{exact:false}).waitFor();
   await page.getByRole('button',{name:'确认并开始工作',exact:true}).click();
   await page.waitForFunction(()=>window.counts.start===1);
   assert.equal(await page.getByRole('button',{name:'正在启动…',exact:true}).isDisabled(),true);
   await page.evaluate(()=>window.resolveStart());
   await page.locator('.ent-wk').waitFor();
   assert.equal(await page.evaluate(()=>window.workspace.works[0].steps[0].input),'整理市场事实');
   assert.equal(await page.getByRole('button',{name:'改一版安排',exact:true}).count(),0);
   assert.equal(await page.evaluate(()=>window.counts.start),1);
  });
  await check('execution-plan-contract',async()=>{
   await reset('normal');await page.getByRole('button',{name:'开始自动编排'}).click();
   await page.getByText('正在分析你的工作目标',{exact:true}).waitFor();
   await page.evaluate(()=>window.complete());
   await page.getByRole('button',{name:'执行设置',exact:true}).click();
   await page.getByRole('combobox',{name:'模型',exact:true}).selectOption('model-alternate');
   await page.getByRole('combobox',{name:'访问权限',exact:true}).selectOption('workspace-edit');
   await page.locator('.ent-rs-directory').click();
   await page.getByRole('button',{name:'确认并开始工作',exact:true}).click();
   await page.locator('.ent-wk').waitFor({timeout:3000});
   const input=await page.evaluate(()=>window.lastSettingsInput);
   assert.deepEqual(Object.keys(input).sort(),['draftId','expectedRevision','settings']);
   assert.equal(input.settings.modelId,'model-alternate');
   assert.equal(input.settings.workDir,'D:/fixture');
   assert.equal(input.settings.permissions.preset,'workspace-edit');
   assert.deepEqual(await page.evaluate(()=>window.workspace.works[0].steps.map(step=>[step.title,step.input,step.output])),[
    ['市场调研','整理市场事实','事实清单'],['撰写报告','根据调研结果生成报告','最终报告'],
   ]);
  });
  assert.deepEqual(errors,[]);
  await page.close();
 }
 assert.deepEqual(failures,[]);
} finally {await browser.close();}
