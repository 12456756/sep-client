/* global window, document */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { log } from 'node:console';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const executablePath = [process.env.SEP_PREVIEW_BROWSER,
  `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['PROGRAMFILES(X86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium',
].filter(Boolean).find(existsSync);
assert.ok(executablePath, 'Install Chrome/Edge or set SEP_PREVIEW_BROWSER');
const output = join(process.cwd(), 'output/auto-arrange-scroll');
await mkdir(output, { recursive: true });
const server = await createServer({ configFile: 'vite.preview.config.ts', optimizeDeps: { include: ['react', 'react-dom/client'] }, server: { port: 5187, strictPort: false, open: false } });
await server.listen();
const address = server.httpServer.address();
await fetch(`http://127.0.0.1:${address.port}/main.tsx`);
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/__auto-scroll-test', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module">
    import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
    </script><script type="module">
    import React from '/@fs/${process.cwd().replaceAll('\\', '/')}/node_modules/.vite/deps/react.js';
    import ReactDOM from '/@fs/${process.cwd().replaceAll('\\', '/')}/node_modules/.vite/deps/react-dom_client.js';
    import { AutoArrangeAnimation } from '/components/enterprise/arrange/AutoArrangeAnimation.tsx';
    import '/index.css'; import '/styles/enterprise.css'; import '/styles/arrange.css';
    const h=React.createElement, root=ReactDOM.createRoot(document.getElementById('root'));
    let sequence=0;
    function Fixture({mode,count}) {
      const [settings,setSettings]=React.useState(false);
      const waiting=mode==='waiting', terminal=mode==='failed'||mode==='cancelled';
      const children=h(React.Fragment,null,
        waiting?h('section',{className:'ent-aa-waiting'},h('div',{className:'ent-aa-waiting-head'},h('h2',null,'Employee requests'),h('button',null,'Recheck')),
          h('div',{className:'ent-aa-missing-list'},Array.from({length:count},(_,i)=>h('article',{className:'ent-aa-missing',key:i},h('strong',null,'Missing capability '+(i+1)),h('p',null,'Required capability and matching information'),
          i%2?h('p',{className:'ent-aa-empty'},'No available employee'):h('button',null,'Request employee '+(i+1)))))):null,
        settings?h('div',{className:'ent-auto-plan'},Array.from({length:8},(_,i)=>h('p',{key:i},'Execution setting '+(i+1)))):null,
        h('footer',{className:'ent-arr-foot'},h('button',{onClick:()=>{window.restarted=true;}},'Restart'),h('button',{onClick:()=>setSettings(value=>!value),'aria-expanded':settings},'Settings')));
      const events=terminal?[{type:mode==='failed'?'arrangement_planning_failed':'arrangement_planning_cancelled',data:{}}]:mode==='ready'?[{type:'arrangement_plan_ready',data:{planSummary:'Plan'}}]:[];
      const nodes=mode==='ready'?[{id:'node',subscriptionId:'employee',title:'Work stage',instruction:'Complete the report',expectedOutput:'Report'}]:[];
      const content=mode==='composer'?h('section',{className:'ent-arr-auto'},h('div',{className:'ent-goal-stack'},h('textarea',{'aria-label':'Goal'}))):h(AutoArrangeAnimation,{draft:{id:'fixture',goal:'Goal',status:waiting?'awaiting-employee':mode==='ready'?'ready':'planning',nodes},employees:[],planning:!terminal&&!waiting&&mode!=='ready',planningEvents:events},children);
      return h('div',{className:'ent-shell'},h('main',{className:'ent-shell-main'},h('header',{className:'ent-top',style:{height:56,flex:'0 0 56px'}},'Arrange'),h('div',{className:'ent-scroll ent-scroll-arrange'},h('div',{className:'ent-arr ent-arr-mode-auto'},h('header',{className:'ent-arr-workbench-head'},'Automatic arrangement'),h('div',{className:'ent-arr-view'},h('div',{className:'ent-auto-arrange'},content))))));
    }
    window.show=(mode,count=12)=>{window.restarted=false;root.render(h(Fixture,{key:++sequence,mode,count}));return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));};window.show('waiting');
    </script></body></html>` }));
  await page.goto(`http://127.0.0.1:${address.port}/__auto-scroll-test`);
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
  for (const [width, height] of [[1280, 720], [960, 480], [390, 640]]) {
    await page.setViewportSize({ width, height });
    for (const mode of ['waiting', 'failed', 'cancelled']) {
      await page.evaluate(mode => window.show(mode), mode);
      const section = page.locator('.ent-arr-auto');
      await section.waitFor();
      const scroller = page.locator('.ent-arr-view');
      await scroller.evaluate(element => { element.scrollTop = 0; });
      assert.ok(await section.locator('.ent-aa-head').evaluate(element => element.getBoundingClientRect().top >= element.closest('.ent-arr-view').getBoundingClientRect().top - 1), 'heading must remain reachable at scroll top');
      if (mode === 'waiting') await page.screenshot({ path: join(output, `waiting-top-${width}.png`) });
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByText('Execution setting 8', { exact: true }).waitFor();
      await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
      const restart = page.getByRole('button', { name: 'Restart', exact: true });
      assert.ok(await restart.evaluate(element => {
        const rect = element.getBoundingClientRect(), view = element.closest('.ent-arr-view').getBoundingClientRect();
        return rect.top >= view.top && rect.bottom <= view.bottom + 1;
      }), 'footer must be reachable inside the workbench');
      await restart.click();
      assert.equal(await page.evaluate(() => window.restarted), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 1), false, 'the outer app must not gain a second scrollbar');
      await page.screenshot({ path: join(output, `${mode}-${width}.png`) });
    }
    await page.evaluate(() => window.show('waiting', 1));
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    await page.locator('.ent-arr-view').evaluate(element => { element.scrollTop = 0; });
    const shortLayout = await page.locator('.ent-arr-view').evaluate(element => {
      const content=element.querySelector('.ent-arr-auto'), style=window.getComputedStyle(content);
      const naturalHeight=[...content.children].reduce((sum,child)=>{const style=window.getComputedStyle(child);return sum+child.getBoundingClientRect().height+parseFloat(style.marginTop)+parseFloat(style.marginBottom);},0)+parseFloat(style.paddingTop)+parseFloat(style.paddingBottom);
      return { clientHeight:element.clientHeight, scrollHeight:element.scrollHeight, naturalHeight };
    });
    assert.ok(Math.abs(shortLayout.scrollHeight - Math.max(shortLayout.clientHeight, shortLayout.naturalHeight)) <= 2, `scroll height must reflect content rather than an artificial fixed height: ${width} ${JSON.stringify(shortLayout)}`);
    for (const mode of ['composer', 'analyzing']) {
      await page.evaluate(mode => window.show(mode), mode);
      await page.locator(mode === 'composer' ? '.ent-goal-stack' : '.ent-aa-analyzing').waitFor();
      assert.equal(await page.locator('.ent-aa-content').count(), 0);
      assert.equal(await page.locator('.ent-arr-auto').evaluate(element => window.getComputedStyle(element).justifyContent), mode === 'composer' ? 'flex-end' : 'flex-start');
    }
    await page.evaluate(() => window.show('ready'));
    await page.locator('.ent-aa-result').waitFor();
    assert.equal(await page.locator('.ent-aa-content').count(), 0);
    await page.getByRole('button', { name:'Settings', exact:true }).waitFor();
  }
  assert.deepEqual(errors, []);
  log('PASS: waiting/failure/cancellation scroll, expanded settings, reachable footer, short content and unchanged composer/analysis at desktop and mobile sizes');
} finally { await browser.close(); await server.close(); }
