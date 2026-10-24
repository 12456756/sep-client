import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const root = process.cwd()
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { useArrangementPlans } from './src/features/enterprise/use-arrangement-plans';
const deferred = []; window.calls = []; window.resolveNext = value => deferred.shift()?.(value);
const task = (status, scope = 'scope-a') => ({ id:'task-1', status, activeRunId: status === 'running' ? 'run-1' : null, workType:{ state:'resolved', kind:'arrangement' }, scope });
window.electronAPI = { getArrangementPlan: async () => ({ success:true, plan:null }), getTaskTimeline: async () => ({ success:true, events:[] }), getArrangementExecution: async taskId => { window.calls.push(taskId); return await new Promise(resolve => deferred.push(resolve)); } };
function App() { const [version,setVersion] = React.useState(0); React.useEffect(() => { const onPop = () => setVersion(value => value + 1); addEventListener('popstate', onPop); return () => removeEventListener('popstate', onPop); }, []); const query = new URLSearchParams(location.search); const status = query.get('status') || 'running'; const scope = query.get('scope') || 'scope-a'; const state = useArrangementPlans([task(status, scope)], scope); window.snapshot = state.executions['task-1'] || null; return React.createElement('pre', { 'data-version':version }, JSON.stringify(window.snapshot)); }
createRoot(document.getElementById('root')).render(React.createElement(App));
`
const bundle = await build({ stdin:{ contents:fixture, loader:'tsx', resolveDir:root }, bundle:true, write:false, outfile:'fixture.js', format:'iife', jsx:'automatic', define:{'process.env.NODE_ENV':JSON.stringify('development')} })
const js = bundle.outputFiles[0].text
const server = createServer((request, response) => {
  if (request.url === '/fixture.js') { response.setHeader('Content-Type','text/javascript'); response.end(js); return }
  response.setHeader('Content-Type','text/html'); response.end('<!doctype html><div id="root"></div><script src="/fixture.js"></script>')
})
await new Promise(resolveListening => server.listen(0, '127.0.0.1', resolveListening))
const url = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ headless:true })
const page = await browser.newPage()
await page.goto(`${url}/?status=running&scope=scope-a`)
await page.waitForFunction(() => window.calls?.length === 1)
assert.equal(await page.evaluate(() => window.calls.length), 1, 'initial execution read')
await page.evaluate(() => { history.pushState({}, '', '?status=completed&scope=scope-a'); dispatchEvent(new PopStateEvent('popstate')) })
await page.waitForTimeout(50)
assert.equal(await page.evaluate(() => window.calls.length), 1, 'state change does not overlap old IPC')
await page.evaluate(() => window.resolveNext({ success:true, execution:{ status:'running', media:[] } }))
await page.waitForFunction(() => window.calls.length === 2)
await page.evaluate(() => window.resolveNext({ success:true, execution:{ status:'completed', media:[] } }))
await page.waitForFunction(() => window.snapshot?.status === 'completed')
assert.equal(await page.evaluate(() => window.snapshot.status), 'completed', 'new state eventually wins')
await page.evaluate(() => { history.pushState({}, '', '?status=running&scope=scope-a'); dispatchEvent(new PopStateEvent('popstate')) })
await page.waitForFunction(() => window.calls.length === 3)
await page.evaluate(() => { history.pushState({}, '', '?status=completed&scope=scope-b'); dispatchEvent(new PopStateEvent('popstate')) })
await page.waitForTimeout(50)
assert.equal(await page.evaluate(() => window.calls.length), 3, 'scope switch does not overlap old IPC')
const scopeStarted = Date.now()
await page.evaluate(() => window.resolveNext({ success:true, execution:{ status:'running', media:[] } }))
await page.waitForFunction(() => window.calls.length === 4)
assert.ok(Date.now() - scopeStarted < 1000, 'scope refresh must not wait for the 5s timer')
await page.evaluate(() => window.resolveNext({ success:true, execution:{ status:'completed', media:[] } }))
await page.waitForFunction(() => window.snapshot?.status === 'completed')
assert.equal(await page.evaluate(() => window.snapshot.status), 'completed', 'new scope eventually loads')
await browser.close(); server.close()
console.log('arrangement refresh race fixture passed')
