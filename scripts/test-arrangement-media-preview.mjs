import { createServer } from 'node:http'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const root = process.cwd()
const output = resolve(root, 'output/playwright')
await mkdir(output, { recursive: true })
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ArrangementMediaPanel } from './src/components/workspace/ArrangementMediaPanel';
const media = [{ nodeId:'image-node', nodeRunId:'run-1', kind:'image', operation:'generate', jobId:'img-job', phase:'tracking', lastQueriedAt:Date.parse('2026-10-23T12:34:56Z'), providerWaitMs:18200, downloadMs:240, materializeMs:80, deliveryMs:120, inputs:[], outputs:[{artifactId:'img-output', mime:'image/png', size:1200, status:'pending'}], pendingActions:[] }];
createRoot(document.getElementById('root')).render(React.createElement('main',{className:'ent-shell-main'},React.createElement(ArrangementMediaPanel,{taskId:'task-1',media})));
`
const bundle = await build({ stdin:{ contents:fixture, loader:'tsx', resolveDir:root }, bundle:true, write:false, outfile:'fixture.js', format:'iife', jsx:'automatic', define:{'process.env.NODE_ENV':JSON.stringify('development')} })
const js = bundle.outputFiles[0].text
const cssBundle = await build({ stdin:{ contents:`@import './src/index.css';\n@import './src/styles/enterprise.css';\n@import './src/styles/video-artifacts.css';`, resolveDir:root, loader:'css' }, bundle:true, conditions:['style'], write:false, outfile:'fixture.css', loader:{ '.png':'dataurl', '.woff2':'dataurl' } })
const css = cssBundle.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n')
const server = createServer((request, response) => {
  if (request.url === '/fixture.js') { response.setHeader('Content-Type','text/javascript'); response.end(js); return }
  if (request.url === '/fixture.css') { response.setHeader('Content-Type','text/css'); response.end(css); return }
  response.setHeader('Content-Type','text/html'); response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>`)
})
await new Promise(resolveListening => server.listen(0, '127.0.0.1', resolveListening))
const url = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ headless:true })
for (const viewport of [{ width:1280, height:800 }, { width:390, height:844 }]) {
  const page = await browser.newPage({ viewport })
  const failedRequests = []
  page.on('requestfailed', request => failedRequests.push(`${request.url()} ${request.failure()?.errorText || ''}`))
  page.on('response', response => { if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`) })
  await page.goto(url)
  await page.locator('.arrangement-media-artifacts').waitFor()
  const text = await page.locator('.arrangement-media-artifacts').innerText()
  if (text.includes('50%')) throw new Error('media waiting view must not show 50%')
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error('media waiting view overflows viewport')
  if (failedRequests.length) throw new Error(`fixture asset requests failed: ${failedRequests.join(' | ')}`)
  const mediaStyle = await page.locator('.media-job').evaluate(element => ({ display:getComputedStyle(element).display, padding:getComputedStyle(element).padding, border:getComputedStyle(element).borderTopWidth }))
  if (mediaStyle.padding === '0px' && mediaStyle.border === '0px') throw new Error('media job styles were not loaded')
  await page.screenshot({ path: resolve(output, `arrangement-media-${viewport.width}.png`), fullPage:true })
  await page.close()
}
await browser.close()
server.close()
console.log(JSON.stringify({ url, output }))
