/* global window, document */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { log } from 'node:console'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { strToU8, zipSync } from 'fflate'
import { convertDocumentPreview } from '../electron/runtime/document-preview-converter.ts'

const candidates = [process.env.SEP_PREVIEW_BROWSER,
  `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['PROGRAMFILES(X86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium'].filter(Boolean)
const executablePath = candidates.find(existsSync)
assert.ok(executablePath, 'Install Chrome/Edge or set SEP_PREVIEW_BROWSER')
const output = join(process.cwd(), 'output/document-preview')
await mkdir(output, { recursive: true })
const docx = zipSync({
  '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'),
  '_rels/.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
  'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>节点交付报告</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>已验收结论</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'),
})
const word = await convertDocumentPreview('docx', docx)
const pdf = await PDFDocument.create()
const font = await pdf.embedFont(StandardFonts.Helvetica)
for (const text of ['Accepted node report', 'Second page']) {
  const page = pdf.addPage([595, 842])
  page.drawText(text, { x: 48, y: 760, font, size: 24, color: rgb(0.1, 0.25, 0.18) })
  page.drawRectangle({ x: 48, y: 540, width: 400, height: 140, color: rgb(0.3, 0.65, 0.45) })
}
const pdfBytes = Array.from(await pdf.save())
const server = await createServer({ configFile: 'vite.preview.config.ts', server: { port: 5186, strictPort: false, open: false } })
await server.listen()
const address = server.httpServer.address()
assert.ok(address && typeof address !== 'string')
const base = `http://127.0.0.1:${address.port}`
const browser = await chromium.launch({ executablePath, headless: true })
try {
  const page = await browser.newPage()
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', error => { errors.push(error.message); log(`Browser error: ${error.message}`) })
  await page.route('**/__document-preview-test', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module">
    import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
    </script><script type="module">
    import React from '/@fs/${process.cwd().replaceAll('\\', '/')}/node_modules/.vite/deps/react.js';
    import ReactDOM from '/@fs/${process.cwd().replaceAll('\\', '/')}/node_modules/.vite/deps/react-dom_client.js';
    import {DocumentPreviewButton} from '/components/workspace/DocumentPreviewButton.tsx';
    import '/index.css';
    window.fixture={content:${JSON.stringify(word)},failure:false,calls:[]};
    window.electronAPI={previewArrangementDocument:async input=>{window.fixture.calls.push(input);return window.fixture.failure?{success:false,error:{message:'测试读取失败'}}:{success:true,data:{name:'节点交付报告.docx',format:'docx',version:'accepted',source:'snapshot',content:window.fixture.content}}}};
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(DocumentPreviewButton,{taskId:'task',nodeId:'node',deliverableId:'report',name:'节点交付报告.docx',format:'docx'}));
    </script></body></html>` }))
  await page.goto(`${base}/__document-preview-test`)
  await page.getByRole('button', { name: '预览文档：节点交付报告.docx' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  const frame = page.frameLocator('.document-preview-frame')
  await frame.getByText('节点交付报告', { exact: true }).waitFor()
  assert.equal(await frame.getByRole('cell', { name: '已验收结论' }).count(), 1)
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 820 })
    assert.ok(await dialog.evaluate(element => element.getBoundingClientRect().width <= window.innerWidth))
    await page.screenshot({ path: join(output, `word-${width}.png`) })
  }
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
  await page.evaluate(() => { window.fixture.failure = true })
  await page.getByRole('button', { name: '预览文档：节点交付报告.docx' }).click()
  await page.getByRole('alert').filter({ hasText: '测试读取失败' }).waitFor()
  await page.evaluate(() => { window.fixture.failure = false })
  await page.getByRole('button', { name: '重试预览' }).click()
  await frame.getByText('节点交付报告', { exact: true }).waitFor()
  await page.getByRole('button', { name: '关闭文档预览' }).click()

  await page.evaluate(bytes => { window.fixture.content = { kind: 'pdf', bytes: new Uint8Array(bytes) } }, pdfBytes)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.getByRole('button', { name: '预览文档：节点交付报告.docx' }).click()
  await page.getByRole('img', { name: 'PDF 第 1 页' }).waitFor()
  await page.waitForFunction(() => {
    const canvas = document.querySelector('.document-preview-pdf canvas')
    return canvas?.width > 0 && !document.querySelector('.document-preview-pdf [role="status"]')
  })
  assert.ok(await page.locator('.document-preview-pdf canvas').evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    let colored = 0
    for (let i = 0; i < data.length; i += 4) if (data[i + 1] > data[i] + 20) colored++
    return colored > 1000
  }), 'PDF canvas must show nonblank page content')
  await page.screenshot({ path: join(output, 'pdf-desktop.png') })
  await page.getByRole('button', { name: 'PDF 下一页' }).click()
  await page.getByRole('img', { name: 'PDF 第 2 页' }).waitFor()
  await page.getByRole('button', { name: '关闭文档预览' }).click()
  await page.evaluate(() => { window.fixture.content = { kind: 'html', sections: [{ title: 'Unsafe', html: '<h1>Sanitized document</h1><script>window.bad=true</script><img src="https://example.com/tracker.png" onerror="window.bad=true"><img src="data:image/svg+xml;base64,AAAA"><form action="javascript:alert(1)"><button>Submit</button></form>' }], notices: [] } })
  await page.getByRole('button', { name: '预览文档：节点交付报告.docx' }).click()
  await frame.getByRole('heading', { name: 'Sanitized document' }).waitFor()
  assert.equal(await frame.locator('script, form, button, svg, [onerror]').count(), 0)
  assert.equal(await frame.locator('img[src]').count(), 0)
  assert.equal(await page.evaluate(() => window.bad), undefined)
  await page.getByRole('button', { name: '关闭文档预览' }).click()
  await page.evaluate(() => { window.fixture.content = { kind: 'markdown', text: '# 节点摘要\n\n结论内容\n\n![remote](https://example.com/tracker.png)\n\n<script>window.bad=true</script>' } })
  await page.getByRole('button', { name: '预览文档：节点交付报告.docx' }).click()
  await page.getByRole('heading', { name: '节点摘要' }).waitFor()
  assert.equal(await page.locator('.document-preview-text img').count(), 0)
  assert.deepEqual(await page.evaluate(() => window.fixture.calls[0]), { taskId: 'task', nodeId: 'node', deliverableId: 'report' })
  assert.deepEqual(errors, [])
  log('PASS: Word desktop/mobile, saved-version IPC identities, retry, close, PDF pages/nonblank canvas, safe Markdown')
  log(`Screenshots: ${output}`)
} finally { await browser.close(); await server.close() }
