/* global document, window, innerWidth */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { _electron } from 'playwright-core'
import { createServer } from 'vite'

const directory = await realpath(await mkdtemp(join(tmpdir(), 'sep-result-electron-')))
let electron
let server
const errors = []
let reactUrl = ''
let domUrl = ''
try {
  await build({ entryPoints: ['scripts/fixtures/result-files-main.ts'], bundle: true, platform: 'node', format: 'cjs',
    external: ['electron'], outfile: join(directory, 'main.cjs'), logLevel: 'silent' })
  server = await createServer({ configFile: 'vite.preview.config.ts', logLevel: 'error', server: { port: 0, strictPort: false },
    plugins: [{ name: 'result-test-page', configureServer(vite) {
      vite.middlewares.use('/__result-test', (_request, response) => {
        response.setHeader('content-type', 'text/html')
        response.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module">
          import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
          const React = (await import('${reactUrl}')).default;
          const ReactDOM = (await import('${domUrl}')).default;
          const {ResultFilesHarness} = await import('/features/enterprise/__fixtures__/result-files-harness.tsx');
          ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(ResultFilesHarness));
        </script></body></html>`)
      })
    } }],
  })
  await server.listen()
  const address = server.httpServer.address()
  assert.ok(address && typeof address === 'object')
  const origin = `http://127.0.0.1:${address.port}`
  const main = await (await fetch(`${origin}/main.tsx`)).text()
  reactUrl = main.match(/from "([^"]*react\.js[^"]*)"/)[1]
  domUrl = main.match(/from "([^"]*react-dom_client[^"]*)"/)[1]
  electron = await _electron.launch({ args: [join(directory, 'main.cjs')], cwd: process.cwd(), env: { ...process.env,
    SEP_RESULT_TEST_ROOT: directory, SEP_RESULT_TEST_PRELOAD: resolve('scripts/fixtures/result-files-preload.cjs'),
    SEP_RESULT_TEST_URL: `${origin}/__result-test`, ELECTRON_RUN_AS_NODE: '',
  } })
  const page = await electron.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await page.getByRole('button', { name: '查看产出结果', exact: true }).click()
  await page.getByRole('img', { name: 'product.png', exact: true }).waitFor()
  await page.waitForFunction(() => document.querySelector('img')?.naturalWidth > 0 && document.querySelector('video')?.readyState >= 2)
  const source = await page.locator('video').getAttribute('src')
  assert.match(source, /^sep-result:\/\/preview\//)
  assert.equal(await page.getByRole('article').count(), 3)
  assert.equal(await page.getByRole('button', { name: /复制路径|预览图片|预览视频/ }).count(), 0)
  const range = await page.evaluate(async url => {
    const partial = await fetch(url, { headers: { Range: 'bytes=0-31' } })
    const invalid = await fetch(url, { headers: { Range: 'bytes=999999-' } })
    return { status: partial.status, length: (await partial.arrayBuffer()).byteLength, contentRange: partial.headers.get('content-range'), invalid: invalid.status }
  }, source)
  assert.deepEqual(range, { status: 206, length: 32, contentRange: 'bytes 0-31/7295', invalid: 416 })
  await page.locator('video').evaluate(async video => { video.muted = true; await video.play() })
  await page.waitForFunction(() => document.querySelector('video').currentTime > 0.2)
  await page.locator('video').evaluate(video => { video.pause(); video.currentTime = 2 })
  await page.waitForFunction(() => Math.abs(document.querySelector('video').currentTime - 2) < 0.1 && !document.querySelector('video').seeking)
  await mkdir('output/playwright', { recursive: true })
  await page.screenshot({ path: 'output/playwright/result-files-desktop.png', fullPage: true })
  await page.getByRole('button', { name: '放大查看 product.png', exact: true }).click()
  await page.getByRole('dialog', { name: '图片预览 product.png' }).waitFor()
  await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('dialog', { name: '图片预览 product.png' }).count(), 0)
  assert.equal(await page.locator('.ent-wk-inspector[open]').count(), 1)
  await page.getByRole('button', { name: '打开 product.png 所在文件夹', exact: true }).click()
  const state = await page.evaluate(() => window.resultTest.state())
  assert.deepEqual(state.revealed, [join(directory, 'workspace', 'product.png')])
  assert.ok(state.requests.some(request => request.range && request.status === 206))
  await page.setViewportSize({ width: 420, height: 800 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: 'output/playwright/result-files-narrow.png', fullPage: true })
  await page.getByRole('button', { name: '关闭详情面板', exact: true }).click()
  assert.equal(await page.locator('video').count(), 0)
  await page.waitForFunction(async url => (await fetch(url)).status === 404, source)
  await page.getByRole('button', { name: '查看产出结果', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2)
  const currentSource = await page.locator('video').getAttribute('src')
  assert.notEqual(currentSource, source)
  await page.evaluate(() => window.resultTest.logout())
  assert.equal(await page.evaluate(async url => (await fetch(url)).status, currentSource), 404)
  assert.deepEqual(errors, [])
  console.log('PASS Electron result files: image zoom, video playback/seek, Range, reveal identity, narrow layout, release and logout')
} catch (error) {
  console.error(errors)
  const page = electron?.windows()[0]
  if (page) console.error((await page.locator('body').innerText()).slice(0, 2500))
  throw error
} finally {
  await electron?.close()
  await server?.close()
  await rm(directory, { recursive: true, force: true })
}
