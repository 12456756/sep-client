/* global window, document, innerWidth */
import assert from 'node:assert/strict'
import { log } from 'node:console'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { chromium } from 'playwright-core'

const origin = process.env.SEP_PREVIEW_ORIGIN ?? 'http://127.0.0.1:5190'
const main = await (await fetch(origin + '/main.tsx')).text()
const react = main.match(/from "([^"]*react\.js[^"]*)"/)[1]
const dom = main.match(/from "([^"]*react-dom_client[^"]*)"/)[1]
const html = `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div class="ent-shell"><div id="root"></div></div><script type="module">
window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
await import('/index.css');await import('/styles/enterprise.css');
const React=(await import('${react}')).default;
const dom=await import('${dom}');const {createRoot}=dom.default??dom;
const {SkillsPage}=await import('/pages/enterprise/SkillsPage.tsx');
const versions=[
  {id:'v2',capabilityId:'cap',scope:'ENTERPRISE',status:'ENTERPRISE_APPROVED',version:'2.0'},
  {id:'v1',capabilityId:'cap',scope:'PLATFORM',status:'PLATFORM_APPROVED',version:'1.0'},
  {id:'personal',capabilityId:'cap',scope:'PERSONAL',status:'ENTERPRISE_APPROVED',version:'mine',changeSummary:'Personal edit'}
];
const currentVersion=versions[new URLSearchParams(window.location.search).get('source')==='platform'?1:0];
const initial={capability:{id:'cap',name:'Skill',description:'Analysis',type:'SKILL'},versions,usableVersionIds:versions.map(v=>v.id),localVersions:[],bindings:[{subscriptionId:'sub',employeeId:'Employee',currentVersion,selectedVersionId:'personal',selectionMode:'personal'}]};
window.calls=[];
function App(){
  const [skill,setSkill]=React.useState(initial);const [view,setView]=React.useState({name:'skills'});
  const previewSkillSource=React.useCallback(async()=> '# Test',[]);
  const workspace={skills:[skill],employees:[],skillsLoading:false,skillsError:null,skillsWarning:null,previewSkillSource,refreshSkills:async()=>{},navigate:setView,
    selectSkillVersion:async(capabilityId,versionId)=>{
      window.calls.push({capabilityId,versionId});
      setSkill(s=>({...s,bindings:s.bindings.map(b=>({...b,selectionMode:versionId==='follow-platform'?'follow-platform':'personal',selectedVersionId:versionId==='follow-platform'?b.currentVersion.id:versionId}))}));
    }};
  return React.createElement(SkillsPage,{workspace,skillId:view.skillId});
}
createRoot(document.getElementById('root')).render(React.createElement(App));
</script></body></html>`

const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  for (const { width, source } of [1280, 390].flatMap(width => ['enterprise', 'platform'].map(source => ({ width, source })))) {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.setDefaultTimeout(10_000)
    try {
      await page.route('**/__skill-follow?*', route => route.fulfill({ contentType: 'text/html', body: html }))
      await page.goto(origin + '/__skill-follow?source=' + source)
      const select = page.locator('.skill-active-version select')
      await select.waitFor()
      assert.deepEqual(await select.locator('option').evaluateAll(options => options.map(option => option.value)), ['follow-platform', 'personal'])
      await select.selectOption('follow-platform')
      await page.waitForFunction(() => window.calls.length === 1)
      assert.equal(await select.inputValue(), 'follow-platform')
      assert.equal(await select.locator('option:checked').textContent(), source === 'enterprise' ? '\u4f01\u4e1a\u7248 2.0' : '\u5e73\u53f0\u7248 1.0')
      assert.deepEqual(await page.evaluate(() => window.calls), [{ capabilityId: 'cap', versionId: 'follow-platform' }])
      await page.screenshot({ path: join(tmpdir(), `sep-skill-follow-${source}-${width}.png`), fullPage: true })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.locator('.skill-card-bottom button').click()
      await page.locator('.skill-history').waitFor()
      assert.equal(await page.locator('.skill-version-row').count(), 3)
      assert.deepEqual(errors, [])
      log(`PASS ${width}px ${source}: version label, follow selection, public history, no overflow`)
    } finally { await page.close() }
  }
} finally { await browser.close() }
