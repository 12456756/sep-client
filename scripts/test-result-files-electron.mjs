/* global document, window, innerWidth */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'
import { _electron } from 'playwright-core'
import { createServer } from 'vite'

const directory = await realpath(await mkdtemp(join(tmpdir(), 'sep-result-electron-')))
const screenshotDirectory = process.env.SEP_RESULT_TEST_OUTPUT || join(directory, 'screenshots')
let electron
let server
const errors = []
const loadFailures = []
let reactUrl = ''
let domUrl = ''

async function assertImageCopy(image, copy) {
  const expected = await image.evaluate(async element => {
    await element.decode()
    return { width: element.naturalWidth, height: element.naturalHeight }
  })
  const saved = await electron.evaluate(({ clipboard }) => clipboard.availableFormats().map(format => ({ format, bytes: [...clipboard.readBuffer(format)] })))
  try {
    await electron.evaluate(({ clipboard }) => clipboard.clear())
    await copy()
    for (let i = 0; i < 50; i++) {
      const size = await electron.evaluate(({ clipboard }) => clipboard.readImage().getSize())
      if (size.width || size.height) { assert.deepEqual(size, expected); return }
      await delay(100)
    }
    assert.fail('No image was written to the system clipboard')
  } finally {
    await electron.evaluate(({ clipboard }, previous) => {
      clipboard.clear()
      for (const item of previous) clipboard.writeBuffer(item.format, Buffer.from(item.bytes))
    }, saved)
  }
}

try {
  await build({ entryPoints: ['scripts/fixtures/result-files-main.ts'], bundle: true, platform: 'node', format: 'cjs',
    external: ['electron'], outfile: join(directory, 'main.cjs'), logLevel: 'silent' })
  server = await createServer({ configFile: 'vite.preview.config.ts', logLevel: 'error', cacheDir: join(directory, 'vite-cache'),
    server: { port: 0, strictPort: false },
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
  const electronEnvironment = { ...process.env }
  delete electronEnvironment.ELECTRON_RUN_AS_NODE
  electron = await _electron.launch({ args: [join(directory, 'main.cjs')], cwd: process.cwd(), env: { ...electronEnvironment,
    SEP_RESULT_TEST_ROOT: directory, SEP_RESULT_TEST_PRELOAD: resolve('scripts/fixtures/result-files-preload.cjs'),
    SEP_RESULT_TEST_URL: `${origin}/__result-test`,
  } })
  const page = await electron.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => {
    if (response.url().startsWith(`${origin}/`) && response.status() >= 400) {
      loadFailures.push(`${response.status()} ${new URL(response.url()).pathname}`)
    }
  })
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
  await mkdir(screenshotDirectory, { recursive: true })
  await page.screenshot({ path: join(screenshotDirectory, 'result-files-desktop.png'), fullPage: true })
  await page.evaluate(() => window.resultTest.secure())
  const resultImage = page.getByRole('img', { name: 'product.png', exact: true })
  const localPage = join(directory, 'file-origin.html')
  await writeFile(localPage, '<!doctype html><title>Result file-origin test</title>')
  const fileOriginResponse = await electron.evaluate(async ({ BrowserWindow }, { path, url }) => {
    const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } })
    try {
      await window.loadFile(path)
      return await window.webContents.executeJavaScript(`fetch(${JSON.stringify(url)}).then(async response => ({
        ok: response.ok, mime: response.headers.get('Content-Type'), bytes: (await response.arrayBuffer()).byteLength
      }))`)
    } finally { window.destroy() }
  }, { path: localPage, url: await resultImage.getAttribute('src') })
  assert.equal(fileOriginResponse.ok, true)
  assert.equal(fileOriginResponse.mime, 'image/png')
  assert.ok(fileOriginResponse.bytes > 0)
  const arrangementMenu = page.getByRole('menu', { name: '文件操作' })
  const arrangementActions = ['打开文件夹', '在默认应用打开', '复制路径', '另存为']
  await page.getByRole('article', { name: '产物 brief.md' }).getByText('brief.md', { exact: true }).click({ button: 'right' })
  await arrangementMenu.waitFor()
  assert.deepEqual(await arrangementMenu.getByRole('menuitem').allTextContents(), arrangementActions)
  await page.keyboard.press('Escape')
  await assertImageCopy(resultImage, async () => {
    await resultImage.click({ button: 'right' })
    await arrangementMenu.waitFor()
    assert.deepEqual(await arrangementMenu.getByRole('menuitem').allTextContents(), [...arrangementActions, '复制图片'])
    await page.getByRole('menuitem', { name: '复制图片', exact: true }).click()
  })
  const copyPath = async target => {
    const priorClipboard = await electron.evaluate(({ clipboard }) => clipboard.availableFormats().map(format => ({ format, bytes: [...clipboard.readBuffer(format)] })))
    try {
      await electron.evaluate(({ clipboard }) => clipboard.clear())
      await target.click({ button: 'right' })
      await page.getByRole('menuitem', { name: '复制路径', exact: true }).click()
      for (let attempt = 0; attempt < 50; attempt++) {
        const value = await electron.evaluate(({ clipboard }) => clipboard.readText())
        if (value) return value
        await delay(100)
      }
      assert.fail('No path was written to the system clipboard')
    } finally {
      await electron.evaluate(({ clipboard }, previous) => {
        clipboard.clear()
        for (const item of previous) clipboard.writeBuffer(item.format, Buffer.from(item.bytes))
      }, priorClipboard)
    }
  }
  assert.equal(await copyPath(resultImage), join(directory, 'workspace', 'product.png'))
  await page.getByRole('button', { name: '放大查看 product.png', exact: true }).click()
  const imageDialog = page.getByRole('dialog', { name: '图片预览 product.png' })
  const largeImage = imageDialog.getByRole('img', { name: 'product.png', exact: true })
  await largeImage.press('Shift+F10')
  await imageDialog.getByRole('menuitem', { name: '复制图片' }).waitFor()
  assert.deepEqual(await imageDialog.getByRole('menuitem').allTextContents(), [...arrangementActions, '复制图片'])
  await page.keyboard.press('Escape')
  assert.equal(await imageDialog.isVisible(), true)
  await assertImageCopy(largeImage, async () => {
    await imageDialog.getByRole('button', { name: '复制图片', exact: true }).click()
  })
  await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('dialog', { name: '图片预览 product.png' }).count(), 0)
  assert.equal(await page.locator('.ent-wk-inspector[open]').count(), 1)
  await page.getByRole('button', { name: '打开 product.png 所在文件夹', exact: true }).click()
  await page.waitForFunction(async () => (await window.resultTest.state()).revealed.length === 1)
  const state = await page.evaluate(() => window.resultTest.state())
  assert.deepEqual(state.revealed, [join(directory, 'workspace', 'product.png')])
  assert.ok(state.requests.some(request => request.range && request.status === 206))
  await page.setViewportSize({ width: 420, height: 800 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: join(screenshotDirectory, 'result-files-narrow.png'), fullPage: true })
  await page.getByRole('button', { name: '关闭详情面板', exact: true }).click()
  assert.equal(await page.locator('video').count(), 0)
  await page.waitForFunction(async url => (await fetch(url)).status === 404, source)
  await page.getByRole('button', { name: '查看产出结果', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2)
  const currentSource = await page.locator('video').getAttribute('src')
  assert.notEqual(currentSource, source)
  await page.goto(`${origin}/__result-test?conversation=1`)
  await page.setViewportSize({ width: 1280, height: 900 })
  const inlineResults = page.locator('.ent-conversation-results')
  await inlineResults.locator('img').waitFor()
  await page.waitForFunction(() => document.querySelector('.ent-conversation-results img')?.naturalWidth > 0 && document.querySelector('.ent-conversation-results video')?.readyState >= 2)
  assert.equal(await inlineResults.locator('.result-file-card').count(), 2)
  const inlineSource = await inlineResults.locator('video').getAttribute('src')
  await page.evaluate(() => window.resultTest.secure())
  const inlineImage = inlineResults.locator('img')
  await assertImageCopy(inlineImage, async () => {
    await inlineImage.click({ button: 'right' })
    assert.equal(await inlineResults.getByRole('menuitem', { name: '添加到对话框', exact: true }).isEnabled(), true)
    await inlineResults.getByRole('menuitem', { name: '复制图片', exact: true }).click()
  })
  await inlineResults.locator('video').hover()
  // Chromium's native media buttons live in a user-agent shadow root.
  const cdp = await page.context().newCDPSession(page)
  const toggleNativeFullscreen = async () => {
    await inlineResults.locator('video').hover()
    const tree = await cdp.send('DOM.getDocument', { depth: -1, pierce: true })
    const fullscreenButtons = []
    const visit = node => {
      if (node.attributes?.includes('-webkit-media-controls-fullscreen-button')
        && !node.attributes.includes('display: none;')) fullscreenButtons.push(node.backendNodeId)
      for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) visit(child)
    }
    visit(tree.root)
    assert.ok(fullscreenButtons.length > 0, 'native video controls must expose their fullscreen button')
    const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: fullscreenButtons[0] })
    await page.mouse.click((model.border[0] + model.border[4]) / 2, (model.border[1] + model.border[5]) / 2)
  }
  await toggleNativeFullscreen()
  await page.waitForFunction(() => document.fullscreenElement?.tagName === 'VIDEO', null, { timeout: 5000 })
  await inlineResults.locator('video').evaluate(async video => { video.muted = true; await video.play() })
  await page.waitForFunction(() => document.fullscreenElement.currentTime > 0.2)
  await inlineResults.locator('video').evaluate(video => video.pause())
  await page.screenshot({ path: join(screenshotDirectory, 'conversation-video-fullscreen.png') })
  await toggleNativeFullscreen()
  await page.waitForFunction(() => document.fullscreenElement === null)
  await cdp.detach()
  await page.screenshot({ path: join(screenshotDirectory, 'conversation-inline-results.png'), fullPage: true })
  await page.getByRole('button', { name: '查看产出结果', exact: true }).click()
  const resultDialog = page.locator('.ent-wk-inspector')
  const resultCards = resultDialog.locator('.result-file-card')
  const resultVideo = resultDialog.locator('video')
  const imageResults = resultDialog.getByRole('region', { name: '图片成果', exact: true })
  const videoResults = resultDialog.getByRole('region', { name: '视频成果', exact: true })
  await imageResults.getByRole('alert').filter({ hasText: /部分图片未生成成功.*第 2 项：生成内容被审核拒绝.*已生成的成果可继续使用/ }).waitFor({ timeout: 8_000 })
  await imageResults.getByRole('alert').filter({ hasText: /图片生成失败.*第 1 项：生成供应商当前繁忙/ }).waitFor({ timeout: 8_000 })
  await videoResults.getByRole('alert').filter({ hasText: /部分视频未生成成功.*第 2 项：生成供应商响应超时.*已生成的成果可继续使用/ }).waitFor({ timeout: 8_000 })
  await videoResults.getByRole('alert').filter({ hasText: /^视频生成失败：生成内容未通过安全审核/ }).waitFor({ timeout: 8_000 })
  assert.equal(await imageResults.getByRole('alert').count(), 2)
  assert.equal(await videoResults.getByRole('alert').count(), 2)
  assert.doesNotMatch(await resultDialog.innerText(), /ContentModerationFailed|UPSTREAM_FAILED|fixture-private-provider-detail|正在下载|保存失败|没有取得更具体的原因/)
  await page.waitForFunction(() => document.querySelector('.ent-wk-inspector .result-file-card img')?.naturalWidth > 0 && document.querySelector('.ent-wk-inspector video')?.readyState >= 2)
  assert.equal(await resultCards.count(), 2)
  assert.equal(await resultDialog.getByRole('button', { name: /^(预览|导出)(视频|图片)?/ }).count(), 0)
  assert.equal(await resultVideo.evaluate(video => video.paused && video.currentTime === 0), true)
  await resultVideo.scrollIntoViewIfNeeded()
  const bounds = await resultVideo.boundingBox()
  assert.ok(bounds)
  const frame = await page.screenshot({ clip: { x: bounds.x + bounds.width / 2 - 4, y: bounds.y + bounds.height / 2 - 4, width: 8, height: 8 } })
  const visibleFrame = await electron.evaluate(({ nativeImage }, base64) => {
    const pixels = nativeImage.createFromBuffer(Buffer.from(base64, 'base64')).toBitmap()
    let colored = 0
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) - Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]) > 20) colored++
    }
    return colored > pixels.length / 8
  }, frame.toString('base64'))
  assert.equal(visibleFrame, true, 'historical conversation video must paint its first frame before playback')
  await page.screenshot({ path: join(screenshotDirectory, 'result-files-conversation.png'), fullPage: true })
  const conversationSource = await resultVideo.getAttribute('src')
  await resultVideo.evaluate(async video => { video.muted = true; await video.play() })
  await page.waitForFunction(() => document.querySelector('.ent-wk-inspector video').currentTime > 0.2)
  await resultVideo.evaluate(video => { video.pause(); video.currentTime = 2 })
  await page.waitForFunction(() => Math.abs(document.querySelector('.ent-wk-inspector video').currentTime - 2) < 0.1 && !document.querySelector('.ent-wk-inspector video').seeking)
  assert.equal(await resultCards.nth(1).locator('video').count(), 1)
  const videoFolder = resultCards.nth(1).getByRole('button', { name: /所在文件夹/ })
  await videoFolder.click()
  await page.waitForFunction(async () => {
    const state = await window.resultTest.state()
    return state.revealCalls.some(input => input.jobId === 'video-job' && input.outputId === 'video-output-1')
  })
  const conversationState = await page.evaluate(() => window.resultTest.state())
  assert.ok(conversationState.revealCalls.some(input => input.jobId === 'video-job' && input.outputId === 'video-output-1'))
  const copiedVideo = await copyPath(resultVideo)
  const savedVideo = relative(join(directory, 'generated'), copiedVideo)
  assert.ok(isAbsolute(copiedVideo) && !isAbsolute(savedVideo) && !savedVideo.startsWith(`..${sep}`))
  assert.match(savedVideo.split(sep)[0], /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(copiedVideo, conversationState.revealed.at(-1))
  assert.deepEqual(await readFile(copiedVideo), await readFile(conversationState.videoPath))
  await resultCards.nth(0).getByRole('button', { name: /放大查看/ }).click()
  const conversationPreview = page.locator('.result-image-dialog[open]')
  await assertImageCopy(conversationPreview.locator('img'), async () => {
    await conversationPreview.locator('img').click({ button: 'right' })
    await conversationPreview.getByRole('menuitem', { name: '复制图片', exact: true }).click()
  })
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('.ent-wk-inspector[open]').count(), 1)
  await page.setViewportSize({ width: 420, height: 800 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: join(screenshotDirectory, 'result-files-conversation-narrow.png'), fullPage: true })
  await page.getByRole('button', { name: '关闭详情面板', exact: true }).click()
  assert.equal(await resultVideo.count(), 0)
  assert.equal(await inlineResults.locator('video').count(), 1)
  assert.equal(await page.evaluate(async url => (await fetch(url)).status, inlineSource), 200)
  await page.waitForFunction(async url => (await fetch(url)).status === 404, conversationSource)
  await page.getByRole('button', { name: '查看产出结果', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.ent-wk-inspector video')?.readyState >= 2)
  assert.equal(await resultDialog.getByRole('alert').count(), 4, 'persisted errors survive reopening the results panel')
  const finalSource = await resultVideo.getAttribute('src')
  await page.evaluate(() => window.resultTest.logout())
  assert.equal(await page.evaluate(async url => (await fetch(url)).status, finalSource), 404)
  for (const [kind, label] of [['image', '图片'], ['video', '视频']]) {
    await page.goto(`${origin}/__result-test?replay=${kind}`)
    const banner = page.locator('[aria-label="任务失败"]')
    await banner.getByText(/媒体提交结果尚未确认.*勿重复提交/).waitFor()
    await page.locator('.ent-conversation-status').getByText(/勿重复提交/).waitFor()
    await page.locator('.ent-conversation-queue > summary').click()
    assert.equal(await page.getByRole('button', { name: /重试任务|重试并继续|重建会话并继续|重新执行/ }).count(), 0)
    await banner.getByRole('button', { name: '查看原任务', exact: true }).click()
    await page.getByRole('region', { name: '产出结果', exact: true }).getByText(new RegExp(`${label}提交结果尚未确认`)).first().waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  }
  assert.deepEqual((await page.evaluate(() => window.resultTest.state())).blockedRequests, [])
  assert.deepEqual(errors, [])
  console.log('PASS Electron results: native image copy, file-origin reads, preview, playback, Range, reveal, narrow layout, release and logout; no generation requests')
} catch (error) {
  console.error({ errors, loadFailures })
  const page = electron?.windows()[0]
  if (page) console.error((await page.locator('body').innerText()).slice(0, 2500))
  throw error
} finally {
  await electron?.close()
  await server?.close()
  await rm(directory, { recursive: true, force: true })
}
