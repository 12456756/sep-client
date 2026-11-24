/* global window, getComputedStyle */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import { _electron } from 'playwright-core'

const requests = []
const server = createServer((request, response) => {
  if (request.url === '/') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(`<!doctype html><html data-platform="${process.platform}"><head><meta charset="utf-8"><title>Static preview smoke</title></head><body><div class="ent-shell" id="root"></div></body></html>`)
    return
  }
  if (request.url.startsWith('/resource/')) requests.push(request.url)
  response.writeHead(404).end()
})
const bundle = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client';
    import { DocumentPreviewButton } from './src/components/workspace/DocumentPreviewButton';
    import { FeedbackProvider } from './src/components/feedback/FeedbackProvider';
    const root = createRoot(document.getElementById('root'));
    window.renderPreview = (name, format, content) => {
      window.previewCalls = [];
      window.electronAPI = { previewArrangementDocument: async request => {
        window.previewCalls.push(request);
        return { success: true, data: { name, format, content, version: 'v1', source: 'conversation-file' } };
      } };
      root.render(<FeedbackProvider><DocumentPreviewButton key={name} taskId="task" fileId="task-file-0" name={name} format={format} /></FeedbackProvider>);
    };
  ` },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'empty' },
  plugins: [{ name: 'skip-lazy-pdf', setup(build) {
    build.onResolve({ filter: /^\.\/PdfDocumentPreview$/ }, () => ({ path: 'pdf', namespace: 'fixture' }))
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export default () => null' }))
  } }],
})

await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
const base = `http://127.0.0.1:${server.address().port}`
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6ioAAAAASUVORK5CYII='
const html = `<!doctype html><html lang="zh-CN"><head>
  <meta http-equiv="refresh" content="0;url=${base}/resource/refresh">
  <base href="${base}/resource/">
  <link rel="stylesheet" href="${base}/resource/style">
  <link rel="preconnect" href="${base}">
  <style>@import url('${base}/resource/import'); body.report h1 { color: rgb(12, 34, 56); background-image: url('${base}/resource/background'); }</style>
  </head><body class="report"><main><h1>竞品报告</h1><table><tr><td style="font-weight: 700">静态数据</td></tr></table>
  <img alt="嵌入图片" src="data:image/png;base64,${png}">
  <img alt="外部图片" src="${base}/resource/image" srcset="${base}/resource/srcset 2x" onerror="document.body.dataset.ran = 'handler'">
  <img alt="相对图片" src="assets/photo.png"><img alt="本机文件" src="file:///private.png">
  <script>document.body.dataset.ran = 'script'</script>
  <iframe src="${base}/resource/frame"></iframe><form action="${base}/resource/form"><input></form>
  <a id="outside" href="${base}/resource/link">外部链接</a></main></body></html>`
let electron
try {
  const env = { ...process.env, SEP_STATIC_HTML_TEST_URL: base }
  delete env.ELECTRON_RUN_AS_NODE
  electron = await _electron.launch({ args: ['scripts/fixtures/static-html-preview-main.mjs'], cwd: process.cwd(), env })
  const page = await electron.firstWindow()
  await page.waitForURL(`${base}/`)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const theme = await readFile('src/styles/enterprise.css', 'utf8')
  await page.addStyleTag({ content: theme.replace(/^@import[^\r\n]+/gm, '') })
  await page.addStyleTag({ content: await readFile('src/components/workspace/document-preview.css', 'utf8') })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.evaluate(source => window.renderPreview('竞品报告.HTML', 'HTML', { kind: 'text', text: source }), html)
  await page.getByRole('button', { name: '预览文档：竞品报告.HTML' }).click()
  const dialog = page.getByRole('dialog', { name: '文档预览：竞品报告.HTML' })
  const iframe = dialog.locator('iframe')
  const frame = iframe.contentFrame()
  await frame.getByRole('heading', { name: '竞品报告' }).waitFor()
  assert.equal(await iframe.getAttribute('sandbox'), '')
  assert.equal(await iframe.getAttribute('referrerpolicy'), 'no-referrer')
  assert.equal(await frame.getByRole('heading', { name: '竞品报告' }).evaluate(h => getComputedStyle(h).color), 'rgb(12, 34, 56)')
  assert.equal(await frame.getByRole('cell', { name: '静态数据' }).evaluate(td => getComputedStyle(td).fontWeight), '700')
  assert.equal(await frame.getByRole('img', { name: '嵌入图片' }).evaluate(async img => { await img.decode(); return img.naturalWidth }), 1)
  assert.equal(await frame.locator('script, iframe, form, input, link, base, [onerror], [srcset], a[href], meta[http-equiv="refresh"]').count(), 0)
  assert.equal(await frame.locator('img[src]').count(), 1)
  assert.equal(await frame.locator('body').getAttribute('data-ran'), null)
  assert.equal(await iframe.evaluate(element => element.contentDocument), null, 'sandboxed preview must have an opaque origin')
  const visiblePanel = await dialog.evaluate(element => getComputedStyle(element).backgroundColor)
  await page.setViewportSize({ width: 390, height: 800 })
  await page.locator('#root').evaluate(root => root.classList.add('dark'))
  assert.notEqual(await dialog.evaluate(element => getComputedStyle(element).backgroundColor), visiblePanel)
  const bounds = await dialog.locator('.document-preview-toolbar').evaluate(element => {
    const actions = element.querySelector('.document-preview-actions').getBoundingClientRect()
    const modes = element.querySelector('.document-preview-modes').getBoundingClientRect()
    return { fit: element.scrollWidth <= element.clientWidth, right: actions.right, overlap: modes.right > actions.left && modes.bottom > actions.top }
  })
  assert.ok(bounds.fit && !bounds.overlap && bounds.right <= 390, 'mode and zoom controls must fit a narrow window')
  await dialog.getByRole('button', { name: '放大文档' }).click()
  await frame.locator('body[style*="zoom: 1.1"]').waitFor()
  const source = dialog.getByRole('button', { name: '查看源码' })
  await source.focus()
  await page.keyboard.press('Enter')
  assert.equal(await dialog.getByRole('button', { name: '查看源码' }).getAttribute('aria-pressed'), 'true')
  assert.equal(await dialog.locator('pre').textContent(), html)
  assert.equal(await iframe.count(), 0)
  await dialog.getByRole('button', { name: '预览效果' }).click()
  await frame.getByRole('heading', { name: '竞品报告' }).waitFor()
  assert.deepEqual(await page.evaluate(() => window.previewCalls), [{ taskId: 'task', fileId: 'task-file-0' }])
  assert.deepEqual(requests, [], 'HTML and CSS must not request external resources')
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
  assert.ok(await page.getByRole('button', { name: '预览文档：竞品报告.HTML' }).evaluate(button => button.ownerDocument.activeElement === button))

  await page.evaluate(() => window.renderPreview('report.docx', 'docx', { kind: 'html', notices: [], sections: [{ title: '正文', html: '<h1>Existing Office preview</h1>' }] }))
  await page.getByRole('button', { name: '预览文档：report.docx' }).click()
  await page.frameLocator('.document-preview-frame').getByRole('heading', { name: 'Existing Office preview' }).waitFor()
  assert.equal(await page.getByRole('button', { name: '查看源码' }).count(), 0)
  assert.deepEqual(errors, [])
  process.stdout.write(`PASS: static HTML rendering, source toggle, resource isolation and Office regression on ${process.platform}/${process.arch}\n`)
} finally {
  try { await electron?.close() } finally { server.close(); server.closeAllConnections() }
}
