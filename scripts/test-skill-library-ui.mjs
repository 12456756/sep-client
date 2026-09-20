/* global window, document, fetch */
// Isolated IPC fixtures matching platform contracts. No fixture data enters production storage.
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
const html = `<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">
window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
await import('/index.css'); await import('/styles/enterprise.css'); await import('/styles/arrange.css');
const React = (await import('${reactUrl}')).default;
const {createRoot} = (await import('${domUrl}')).default;
const {SkillsPage} = await import('/pages/enterprise/SkillsPage.tsx');
const {useSkillLibrary} = await import('/features/enterprise/use-skill-library.ts');
const {ArrangeWorkPage} = await import('/pages/enterprise/ArrangeWorkPage.tsx');
const {AppTopBar} = await import('/components/enterprise/AppTopBar.tsx');
window.source = '---\\nname: analysis\\n---\\n# 数据分析\\n\\n保留 **Markdown** 与原文。\\n';
window.sources = {public:window.source,approved:'# 我的已审核版本\\n'};
const publicVersion={id:'public',capabilityId:'cap',scope:'ENTERPRISE',version:'1.2.0',status:'ENTERPRISE_APPROVED'};
const approved={id:'approved',capabilityId:'cap',scope:'PERSONAL',ownerId:'user',version:'opaque-personal-id',parentVersionId:'public',status:'ENTERPRISE_APPROVED',changeSummary:'已审核优化版'};
window.library=[{capability:{id:'cap',name:'数据分析',description:'读取数据并生成分析报告，保留原文与版本。',type:'SKILL'},bindings:[{subscriptionId:'sub-a',employeeId:'emp-a',currentVersion:publicVersion,selectedVersionId:'public'},{subscriptionId:'sub-b',employeeId:'emp-b',currentVersion:publicVersion,selectedVersionId:'public'}],usableVersionIds:['public','approved'],versions:[publicVersion,approved],localVersions:[]}];
window.calls=[];window.failUpload=false;window.failList=false;window.failSelect=false;
const employee=id=>({id,name:id==='sub-a'?'数据分析师':'报告撰写员',availability:'ready',assignedToMe:true,allowedModels:['model-a'],skillIds:['cap'],goodAt:[],cannotDo:[],permissions:[]});
window.electronAPI={
 listSkillLibrary:async()=>window.failList?{success:false,error:{message:'平台连接失败'}}:{success:true,data:structuredClone(window.memberId==='other'?window.library.map(item=>({...item,localVersions:[],usableVersionIds:['public'],bindings:item.bindings.map(binding=>({...binding,selectedVersionId:'public'}))})):window.library)},
 previewLibrarySkill:async input=>({success:true,data:window.sources[input.versionId]}),
 selectSkillVersion:async input=>{window.calls.push(input);if(window.failSelect || !window.library[0].usableVersionIds.includes(input.versionId))return {success:false,error:{message:'版本切换失败'}};window.library=window.library.map(item=>({...item,bindings:item.bindings.map(b=>({...b,selectedVersionId:input.versionId}))}));return {success:true};},
 savePersonalSkill:async input=>{window.calls.push(input);window.sources[input.idempotencyKey]=input.request.content;
  const version={...approved,id:'saved-'+window.calls.length,status:'PENDING_ENTERPRISE_REVIEW',changeSummary:input.request.changeSummary};
  window.library[0].localVersions.push({...input,createdAt:new Date().toISOString(),...(window.failUpload?{}:{uploadedVersion:version})});
  window.library[0].usableVersionIds.push(input.idempotencyKey);
  if(window.failUpload){return {success:true,data:{idempotencyKey:input.idempotencyKey,uploaded:false}};}
  window.sources[version.id]=input.request.content;window.library[0].versions.push(version);return {success:true,data:{idempotencyKey:input.idempotencyKey,uploaded:true,version}};},
 retryPersonalSkillUpload:async input=>{window.calls.push(input);const local=window.library[0].localVersions.find(v=>v.idempotencyKey===input.idempotencyKey);const version={...approved,id:'retry-saved',status:'PENDING_ENTERPRISE_REVIEW',changeSummary:local.request.changeSummary};window.sources[version.id]=local.request.content;window.library[0].versions.push(version);window.library[0].localVersions=window.library[0].localVersions.map(v=>v.idempotencyKey===input.idempotencyKey?{...v,uploadedVersion:version}:v);return {success:true,data:{idempotencyKey:input.idempotencyKey,uploaded:true,version}};},
 onArrangementPlanningEvent:()=>()=>{},
 createArrangementDraft:async input=>{window.calls.push(input);return {success:false,error:{message:'草稿测试结束'}};},
};
function Fixture(){
 const [memberId,setMemberId]=React.useState('user'); window.memberId=memberId;
 const library=useSkillLibrary('enterprise:'+memberId); const [route,navigate]=React.useState({name:'skills'});
 window.switchUser=()=>setMemberId('other');
 window.goAuto=()=>navigate({name:'arrange',mode:'auto'});
 window.goSkills=()=>navigate({name:'skills'});
 const workspace={...library,navigate,employees:[employee('sub-a'),employee('sub-b')],myEmployees:[employee('sub-a'),employee('sub-b')],templates:[],arrangeSeed:null,busy:false,seedArrange:()=>{},chooseFolder:async()=> 'D:/work/my-project'};
 return React.createElement('div',{className:'ent-shell',style:{display:'flex',flexDirection:'column',height:'100vh',marginLeft:200,width:'calc(100% - 200px)'}},React.createElement(AppTopBar,{title:route.name==='skills'?'员工技能':'自动编排'}),React.createElement('main',{style:{overflow:'auto',padding:24,flex:1,minHeight:0}},route.name==='skills'?React.createElement(SkillsPage,{workspace,skillId:route.skillId}):React.createElement(ArrangeWorkPage,{workspace,mode:route.mode})));
}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));
</script></body></html>`;
const browser=await chromium.launch({channel:'msedge',headless:true});
try {
 const page=await browser.newPage(); await page.emulateMedia({reducedMotion:'reduce'}); const errors=[];
 page.on('pageerror',error=>{errors.push(error.message);log(error.message)});
 await page.route('**/__skill-library-test',route=>route.fulfill({contentType:'text/html',body:html}));
 for(const width of [1200,960]) {
  await page.setViewportSize({width,height:width===1200?800:640});
  await page.goto(origin+'/__skill-library-test');
  await page.getByRole('button',{name:'查看并调整'}).waitFor();
  assert.equal(await page.locator('.skill-employee').count(),2);
  await page.screenshot({path:join(tmpdir(),'sep-skill-list-'+width+'.png')});
  await page.getByRole('button',{name:'查看并调整'}).click();
  const source=page.getByRole('textbox',{name:'Skill 原始内容'});
  await source.waitFor();
  await page.waitForFunction(()=>document.querySelector('.skill-source')?.value.includes('# 数据分析'));
  assert.equal(await source.getAttribute('readonly'),'');
  await page.getByRole('button',{name:'修改',exact:true}).click();
  await source.fill('# 个人优化\n\n直接编辑 **原文**。\n');
  await page.getByRole('button',{name:'保存为个人版本',exact:true}).click();
  const dialog=page.getByRole('dialog');await dialog.waitFor();
  await page.getByLabel('版本名称 / 修改说明').fill('我的优化版');
  await page.screenshot({path:join(tmpdir(),'sep-skill-save-'+width+'.png')});
  await page.getByRole('button',{name:'确定保存',exact:true}).click();
  await dialog.waitFor({state:'detached'});
  await page.getByText('已保存个人版本并上传送审。无需等待审核，可返回列表切换为本人本地使用。').waitFor();
  assert.equal(await page.evaluate(()=>window.sources.public),await page.evaluate(()=>window.source));
  assert.equal(await page.evaluate(()=>window.calls.find(c=>c.request).request.content),'# 个人优化\n\n直接编辑 **原文**。\n');
  await page.locator('main').evaluate(element=>{element.scrollTop=0});
  await page.screenshot({path:join(tmpdir(),'sep-skill-detail-'+width+'.png')});
  await page.getByRole('button',{name:'返回技能列表'}).click();
  const selector=page.getByLabel('数据分析当前使用版本');
  assert.equal(await selector.inputValue(),'public');
  const savedKey=await page.evaluate(()=>window.calls.find(c=>c.request).idempotencyKey);
  const remoteId=await page.evaluate(()=>window.library[0].localVersions[0].uploadedVersion.id);
  assert.equal(await selector.locator('option[value="'+remoteId+'"]').getAttribute('disabled'),'');
  assert.equal(await selector.locator('option[value="'+savedKey+'"]').getAttribute('disabled'),null);
  await selector.selectOption(savedKey);
  await page.waitForFunction(key=>window.library[0].bindings.every(b=>b.selectedVersionId===key),savedKey);
  assert.equal(await selector.inputValue(),savedKey);
  await page.evaluate(()=>{window.library[0].versions=window.library[0].versions.map(v=>v.status==='PENDING_ENTERPRISE_REVIEW'?{...v,status:'ENTERPRISE_REJECTED'}:v);window.dispatchEvent(new window.Event('focus'))});
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('option')).some(o=>o.textContent.includes('已驳回')));
  assert.equal(await selector.locator('option[value="'+savedKey+'"]').getAttribute('disabled'),null);
  await selector.selectOption('approved');
  await page.waitForFunction(()=>window.library[0].bindings.every(b=>b.selectedVersionId==='approved'));
  assert.equal(await selector.inputValue(),'approved');
  await page.evaluate(()=>{window.failSelect=true});
  await selector.selectOption('public');await page.getByRole('alert').waitFor();
  assert.equal(await selector.inputValue(),'approved');
  await page.reload();await page.getByRole('button',{name:'查看并调整'}).click();
  await page.getByRole('button',{name:'修改',exact:true}).click();await source.fill('# 本地待上传\n');
  await page.evaluate(()=>{window.failUpload=true});
  await page.getByRole('button',{name:'保存为个人版本',exact:true}).click();
  await page.getByLabel('版本名称 / 修改说明').fill('断网重试版');
  await page.getByRole('button',{name:'确定保存',exact:true}).click();
  const retryKey=await page.evaluate(()=>window.calls.find(c=>c.request).idempotencyKey);
  await page.getByRole('button',{name:'返回技能列表'}).click();
  assert.equal(await selector.locator('option[value="'+retryKey+'"]').getAttribute('disabled'),null);
  await selector.selectOption(retryKey);
  await page.waitForFunction(key=>window.library[0].bindings.every(b=>b.selectedVersionId===key),retryKey);
  await page.getByRole('button',{name:'查看并调整'}).click();
  await page.evaluate(()=>{window.failList=true});
  await page.getByRole('button',{name:'重试上传'}).click();
  await page.getByText('上传成功，已进入审核；不影响本人本地使用。').waitFor();
  assert.equal(await page.evaluate(()=>window.calls.at(-1).idempotencyKey),retryKey);
  await page.getByRole('button',{name:'修改',exact:true}).click();
  await source.fill('# 已保存但列表刷新失败\n');
  await page.evaluate(()=>{window.failList=true;window.failUpload=false});
  await page.getByRole('button',{name:'保存为个人版本',exact:true}).click();
  await page.getByLabel('版本名称 / 修改说明').fill('刷新失败仍保留');
  await page.getByRole('button',{name:'确定保存',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'detached'});
  await page.getByRole('button',{name:'返回技能列表'}).click();
  const fallbackKey=await page.evaluate(()=>window.calls.filter(c=>c.request).at(-1).idempotencyKey);
  assert.equal(await selector.locator('option[value="'+fallbackKey+'"]').getAttribute('disabled'),null);
  await selector.selectOption(fallbackKey);
  await page.waitForFunction(key=>window.library[0].bindings.every(b=>b.selectedVersionId===key),fallbackKey);
  assert.equal(await selector.inputValue(),fallbackKey);
  await page.screenshot({path:join(tmpdir(),'sep-skill-local-'+width+'.png')});
  await page.evaluate(()=>{window.failList=false;window.switchUser()});
  await page.waitForFunction(()=>document.querySelector('.skill-active-version select')?.value==='public');
  assert.equal(await selector.locator('option[value="'+fallbackKey+'"]').count(),0);
  assert.equal(await selector.locator('option[value="'+retryKey+'"]').count(),0);
  assert.equal(await selector.locator('option[value="approved"]').getAttribute('disabled'),'');
  await page.evaluate(()=>window.goAuto());
  await page.getByRole('button',{name:'工作目录',exact:true}).click();
  await page.getByText('my-project',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'附件',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'知识库',exact:true}).count(),0);
  await page.getByRole('button',{name:'运行设置',exact:true}).click();
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('textbox',{name:'工作目标'}).fill('生成分析报告');
  await page.getByRole('button',{name:'开始自动编排'}).click();
  await page.getByText('草稿测试结束').waitFor();
  assert.equal(await page.evaluate(()=>window.calls.at(-1).workspace.path),'D:/work/my-project');
  await page.screenshot({path:join(tmpdir(),'sep-auto-arrange-'+width+'.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
 }
 assert.deepEqual(errors,[]);
 log('PASS skill list, raw edit/save, immutable public source, owner-local selection, rejected review, durable upload retry, refresh failure, user isolation, auto toolbar; 1200x800 / 960x640');
} finally {await browser.close();}
