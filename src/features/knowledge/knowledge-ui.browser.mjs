/* global window, document */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

let server
let browser
let base
let entry
before(async () => {
  const executablePath = [process.env.SEP_PREVIEW_BROWSER, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium'].find(path => path && existsSync(path))
  assert.ok(executablePath, 'Set SEP_PREVIEW_BROWSER to an installed Chromium executable')
  server = await createServer({ configFile: resolve('vite.preview.config.ts'), server: { port: 0, strictPort: false } })
  await server.listen()
  base = server.resolvedUrls.local[0]
  const original = await (await fetch(new URL('main.tsx', base))).text()
  entry = original.slice(0, original.indexOf('import App from'))
  assert.ok(entry.includes('ReactDOM'))
  browser = await chromium.launch({ executablePath, headless: true })
})
after(async () => { await browser?.close(); await server?.close() })

async function openPage(t, { detail = false, pagination = false } = {}) {
  const page = await browser.newPage()
  t.after(() => page.close())
  await page.addInitScript(({ pagination }) => {
    const fixture = window.knowledgeFixture = { calls: [], cancelled: [], pagination, holdUpload: true, releaseUpload: null }
    const ok = data => ({ success: true, data })
    const base = { id: 'kb', name: 'Policies', permissions: { canManage: true } }
    const doc = { id: 'doc', name: 'guide.md', status: 'READY', searchable: true, activeVersion: { id: 'v2', status: 'READY' }, etag: '"revision"' }
    const paged = (request, make) => {
      const pageSize = fixture.pagination ? 5 : 20
      const total = fixture.pagination ? 11 : 1
      const start = (request.page - 1) * pageSize
      return { page: request.page, pageSize, total, items: Array.from({ length: Math.max(0, Math.min(pageSize, total - start)) }, (_, i) => make(start + i)) }
    }
    window.electronAPI = {
      requestKnowledge: async request => {
        fixture.calls.push(request)
        switch (request.action) {
          case 'list': return ok({ ...paged(request, index => ({ ...base, id: index ? `kb-${index}` : 'kb' })), viewer: { isAdmin: true }, capabilities: {}, limits: {} })
          case 'getBase': return ok(base)
          case 'documents': return ok([doc])
          case 'getDocument':
            if (fixture.calls.filter(call => call.action === 'getDocument').length > 1) await new Promise(resolve => setTimeout(resolve, 50))
            return ok(doc)
          case 'versions': return ok([{ id: 'v1', versionNumber: 1, status: 'READY' }, { id: 'v2', versionNumber: 2, status: 'READY' }])
          case 'preview':
            await new Promise(resolve => setTimeout(resolve, 20))
            return ok({ ...paged(request, index => ({ chunkId: `chunk-${index}`, content: `${request.versionId ?? 'v2'} body ${index}` })), versionId: request.versionId ?? 'v2' })
          case 'grants': return ok(paged(request, index => ({ memberId: `member-${index}`, name: `Member ${index}` })))
          case 'members': return ok(paged(request, index => ({ memberId: `candidate-${index}`, name: `Candidate ${index}` })))
          case 'uploadDocument':
            if (fixture.holdUpload) return new Promise(resolve => { fixture.releaseUpload = () => resolve(ok(doc)) })
            return ok(doc)
          default: throw new Error(`Unexpected request: ${request.action}`)
        }
      },
      cancelKnowledgeRequests: async ids => { fixture.cancelled.push(...ids); return { success: true } },
    }
  }, { pagination })
  await page.route(/\/main\.tsx(?:\?.*)?$/, route => route.fulfill({ contentType: 'text/javascript', body: `${entry}
    import { KnowledgePage } from '/pages/enterprise/knowledge/KnowledgePage.tsx';
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null,
      React.createElement(KnowledgePage, { kbId: ${detail ? "'kb'" : 'undefined'}, navigate: () => {} })));` }))
  await page.goto(base)
  await page.getByRole('button', { name: detail ? '刷新状态' : '新建知识库', exact: true }).waitFor()
  return page
}

test('global cancellation stops a multi-file upload and ignores the late first receipt', async t => {
  const page = await openPage(t, { detail: true })
  await page.locator('input[type=file]').setInputFiles([
    { name: 'first.md', mimeType: 'text/markdown', buffer: Buffer.from('first') },
    { name: 'second.md', mimeType: 'text/markdown', buffer: Buffer.from('second') },
  ])
  await page.waitForFunction(() => window.knowledgeFixture.calls.some(call => call.action === 'uploadDocument'))
  await page.getByRole('button', { name: '取消请求', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.kb-upload-panel')?.textContent.includes('已停止'))
  assert.equal(await page.evaluate(() => window.knowledgeFixture.calls.filter(call => call.action === 'uploadDocument').length), 1)
  await page.evaluate(() => window.knowledgeFixture.releaseUpload())
  await page.waitForTimeout(50)
  assert.equal(await page.evaluate(() => window.knowledgeFixture.calls.filter(call => call.action === 'uploadDocument').length), 1)
  assert.equal(await page.getByText('已接收，等待平台处理', { exact: true }).count(), 0)
})

test('reopening the first preview page returns to the active version, not the previous historical result', async t => {
  const page = await openPage(t, { detail: true })
  await page.getByRole('button', { name: '查看', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByText('v2 body 0', { exact: true }).waitFor()
  await dialog.getByRole('button', { name: /版本 1/ }).click()
  await dialog.getByText('v1 body 0', { exact: true }).waitFor()
  await dialog.getByRole('button', { name: '重新打开第一页', exact: true }).click()
  await page.waitForFunction(() => window.knowledgeFixture.calls.filter(call => call.action === 'getDocument').length >= 2)
  await page.waitForTimeout(100)
  assert.equal(await dialog.getByText('v2 body 0', { exact: true }).count(), 1)
  assert.equal(await dialog.getByText('v1 body 0', { exact: true }).count(), 0)
})

test('base listing uses returned pagination metadata to keep remaining rows reachable', async t => {
  const page = await openPage(t, { pagination: true })
  assert.equal(await page.getByRole('button', { name: '下一页', exact: true }).isEnabled(), true)
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await page.getByText('共 11 项 · 第 2 页', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '下一页', exact: true }).isEnabled(), true)
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await page.getByText('共 11 项 · 第 3 页', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '下一页', exact: true }).isDisabled(), true)
})

test('grants, member selection and document preview honor returned page sizes', async t => {
  const page = await openPage(t, { detail: true, pagination: true })
  await page.getByRole('tab', { name: '成员授权', exact: true }).click()
  await page.getByText('Member 0', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '下一页', exact: true }).isEnabled(), true)
  await page.getByRole('button', { name: '添加成员', exact: true }).click()
  const members = page.getByRole('dialog')
  await members.getByText('Candidate 0', { exact: true }).waitFor()
  assert.equal(await members.getByRole('button', { name: '下一页', exact: true }).isEnabled(), true)
  await members.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('tab', { name: '文档', exact: true }).click()
  await page.getByRole('button', { name: '查看', exact: true }).click()
  const preview = page.getByRole('dialog')
  await preview.getByText('v2 body 0', { exact: true }).waitFor()
  assert.equal(await preview.getByRole('button', { name: '下一页', exact: true }).isEnabled(), true)
})
