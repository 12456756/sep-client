/* global window */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

let server, browser, base, entry
before(async () => {
  const executablePath = [process.env.SEP_PREVIEW_BROWSER, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium'].find(path => path && existsSync(path))
  assert.ok(executablePath, 'Set SEP_PREVIEW_BROWSER to an installed Chromium executable')
  server = await createServer({ configFile: resolve('vite.preview.config.ts'), server: { port: 0, strictPort: false } })
  await server.listen()
  base = server.resolvedUrls.local[0]
  const original = await (await fetch(new URL('main.tsx', base))).text()
  entry = original.slice(0, original.indexOf('import App from'))
  browser = await chromium.launch({ executablePath, headless: true })
})
after(async () => { await browser?.close(); await server?.close() })

async function openPage(t, { failList = false, paged = false, width = 900, chat = false, transformed = false, initial = { mode: 'none', knowledgeBaseIds: [] } } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 850 } })
  t.after(() => page.close())
  await page.addInitScript(({ failList, paged }) => {
    const fixture = window.knowledgeFixture = { calls: [], cancelled: [], failList }
    const ok = data => ({ success: true, data })
    window.electronAPI = {
      requestKnowledge: async request => {
        fixture.calls.push(request)
        if (request.action === 'list') {
          if (fixture.failList) return { success: false, error: { statusCode: 503, message: '知识库服务暂不可用' } }
          const items = [{ id: 'policy', name: '公司制度' }, { id: 'product', name: '产品资料' }]
          return ok({ items: paged ? [items[request.page - 1]] : items, total: 2, page: request.page, pageSize: paged ? 1 : 100, viewer: {}, capabilities: {}, limits: {} })
        }
        throw new Error(`Unexpected request: ${request.action}`)
      },
      cancelKnowledgeRequests: async ids => { fixture.cancelled.push(...ids); return { success: true } },
      beginAttachmentImport: async () => ({ success: true, data: { sessionId: 'attachment-session', status: 'open', attachments: [] } }),
      cancelAttachmentImport: async () => ({ success: true }),
    }
  }, { failList, paged })
  await page.route(/\/main\.tsx(?:\?.*)?$/, route => route.fulfill({ contentType: 'text/javascript', body: `${entry}
    import '/index.css';
    import '/styles/enterprise.css';
    import '/styles/arrange.css';
    import { KnowledgeSelector } from '/components/enterprise/KnowledgeSelector.tsx';
    import { ChatArrange } from '/components/enterprise/arrange/ChatArrange.tsx';
    import { FeedbackProvider } from '/components/feedback/FeedbackProvider.tsx';
    function Fixture() {
      const [value, setValue] = React.useState(${JSON.stringify(initial)});
      const [settings, setSettings] = React.useState({ workDir: '', modelId: 'test-model', permissions: { preset: 'read-only', approvalMode: 'confirm-each' }, knowledge: value });
      if (${chat}) return React.createElement(FeedbackProvider, null, React.createElement('main', { style: { padding: 24, marginTop: 160 } }, React.createElement(ChatArrange, {
        employees: [{ id: 'employee-test', name: '测试员工', allowedModels: ['test-model'], skillIds: [], goodAt: [], cannotDo: [] }], employeeId: 'employee-test', onEmployeeChange: () => {}, busy: false, onStart: () => {}, settings, models: ['test-model'], onSettingsChange: patch => setSettings(current => ({ ...current, ...patch })), onChooseFolder: async () => null,
      })));
      return React.createElement('main', { style: ${transformed ? "{ position: 'absolute', left: 260, top: 120, width: 600, height: 660, padding: 24, display: 'flex', alignItems: 'flex-end', transform: 'translateZ(0)', overflow: 'hidden' }" : '{ padding: 20 }'} },
        React.createElement(KnowledgeSelector, { value, onChange: setValue }),
        React.createElement('output', { id: 'selection' }, JSON.stringify(value)));
    }
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Fixture));` }))
  await page.goto(base)
  await page.getByTitle('选择知识库', { exact: true }).click()
  return page
}
const selection = page => page.locator('#selection').textContent().then(JSON.parse)

test('popover stays attached above a docked button inside a transformed and clipped workspace', async t => {
  const page = await openPage(t, { transformed: true, width: 1100 })
  await page.getByRole('button', { name: '公司制度', exact: true }).waitFor()
  const trigger = await page.getByTitle('选择知识库', { exact: true }).boundingBox()
  const popup = await page.getByRole('dialog', { name: '选择知识库' }).boundingBox()
  assert.ok(Math.abs(popup.x - trigger.x) <= 2, 'popover aligns with its button rather than the transformed ancestor')
  assert.ok(Math.abs(popup.y + popup.height - (trigger.y - 8)) <= 2, `popover sits directly above the button: ${JSON.stringify({ trigger, popup })}`)
  assert.ok(popup.x >= 16 && popup.x + popup.width <= 1084)
  await page.getByRole('button', { name: '公司制度', exact: true }).click()
  assert.deepEqual((await selection(page)).knowledgeBaseIds, ['policy'])
  await page.setViewportSize({ width: 750, height: 850 })
  await page.waitForFunction(() => {
    const popup = window.document.querySelector('[aria-label="选择知识库"][role="dialog"]').getBoundingClientRect()
    return popup.right <= window.innerWidth - 15
  })
  mkdirSync('output/playwright', { recursive: true })
  await page.screenshot({ path: 'output/playwright/knowledge-selector-anchored.png' })
  await page.evaluate(() => {
    window.document.documentElement.style.overflow = 'auto'
    window.document.body.style.overflow = 'auto'
    window.document.body.style.minHeight = '1600px'
    window.scrollTo(0, 120)
  })
  await page.waitForFunction(() => {
    const trigger = window.document.querySelector('[title="选择知识库"]').getBoundingClientRect()
    const popup = window.document.querySelector('[aria-label="选择知识库"][role="dialog"]').getBoundingClientRect()
    return window.scrollY === 120 && Math.abs(popup.bottom - (trigger.top - 8)) <= 2
  })
})

test('the knowledge trigger has no border when open or closed', async t => {
  const page = await openPage(t)
  const button = page.getByTitle('选择知识库', { exact: true })
  const border = () => button.evaluate(element => window.getComputedStyle(element).borderTopWidth)
  assert.equal(await border(), '0px')
  await page.keyboard.press('Escape')
  assert.equal(await border(), '0px')
})

test('the portaled popover keeps the workspace dark theme', async t => {
  const page = await openPage(t)
  await page.locator('main').evaluate(element => element.classList.add('ent-shell', 'dark'))
  const colors = await page.getByRole('dialog', { name: '选择知识库' }).evaluate(element => {
    const style = window.getComputedStyle(element)
    return { background: style.backgroundColor, color: style.color }
  })
  assert.deepEqual(colors, { background: 'rgb(26, 29, 38)', color: 'rgb(242, 244, 248)' })
})

test('mounting a selector preserves the restored conversation or node choice', async t => {
  const initial = { mode: 'auto', knowledgeBaseIds: ['policy'] }
  const page = await openPage(t, { initial })
  await page.getByRole('button', { name: '公司制度', exact: true }).waitFor()
  assert.deepEqual(await selection(page), initial)
})

test('the conversation knowledge button sits after the employee and before the model', async t => {
  const page = await openPage(t, { chat: true, width: 1100 })
  const picker = await page.getByTitle('选择知识库', { exact: true }).boundingBox()
  const model = await page.getByRole('combobox', { name: '模型', exact: true }).boundingBox()
  const employee = await page.locator('.ent-chat-who').boundingBox()
  assert.ok(employee && picker && model)
  assert.ok(employee.x < picker.x && picker.x < model.x)
  mkdirSync('output/playwright', { recursive: true })
  await page.screenshot({ path: 'output/playwright/knowledge-chat-position.png' })
})

test('starts empty, uses selected bases and stops using them after all are deselected', async t => {
  const page = await openPage(t)
  assert.deepEqual(await selection(page), { mode: 'none', knowledgeBaseIds: [] })
  await page.getByRole('button', { name: '公司制度', exact: true }).click()
  assert.deepEqual(await selection(page), { mode: 'auto', knowledgeBaseIds: ['policy'] })
  await page.getByRole('button', { name: '产品资料', exact: true }).click()
  assert.deepEqual((await selection(page)).knowledgeBaseIds, ['policy', 'product'])
  await page.getByRole('button', { name: '公司制度', exact: true }).click()
  assert.deepEqual(await selection(page), { mode: 'auto', knowledgeBaseIds: ['product'] })
  await page.getByRole('button', { name: '产品资料', exact: true }).click()
  assert.deepEqual(await selection(page), { mode: 'none', knowledgeBaseIds: [] })
  assert.equal(await page.evaluate(() => window.knowledgeFixture.calls.filter(call => call.action === 'search').length), 0)
})

test('the picker only offers base selection, without retrieval mode controls', async t => {
  const page = await openPage(t)
  await page.getByRole('button', { name: '公司制度', exact: true }).waitFor()
  const dialog = page.getByRole('dialog', { name: '选择知识库' })
  assert.equal(await dialog.getByRole('tablist').count(), 0)
  assert.equal(await dialog.getByRole('button', { name: /^(不使用|自动检索|手动检索|检索|引用到本次提问)$/ }).count(), 0)
  assert.equal(await dialog.getByRole('textbox', { name: '检索问题', exact: true }).count(), 0)
  await page.getByRole('button', { name: '公司制度', exact: true }).click()
  assert.equal(await page.getByTitle('选择知识库', { exact: true }).textContent(), '知识库 · 1')
  assert.equal(await dialog.getByRole('textbox', { name: '检索问题', exact: true }).count(), 0)
})

test('restored manual choices become selected bases without stale queries or citations', async t => {
  const page = await openPage(t, { initial: { mode: 'manual', knowledgeBaseIds: ['policy'], manualQuery: '年假', sources: [{ knowledgeBaseId: 'policy', sourceId: 'source-1' }] } })
  await page.getByRole('button', { name: '公司制度', exact: true }).waitFor()
  assert.deepEqual(await selection(page), { mode: 'auto', knowledgeBaseIds: ['policy'] })
  assert.equal(await page.getByRole('button', { name: '公司制度', exact: true }).getAttribute('aria-pressed'), 'true')
  await page.getByRole('button', { name: '产品资料', exact: true }).click()
  assert.deepEqual(await selection(page), { mode: 'auto', knowledgeBaseIds: ['policy', 'product'] })
})

test('list errors remain visible and reopening refreshes access', async t => {
  const page = await openPage(t, { failList: true })
  await page.getByRole('alert').filter({ hasText: /知识库列表加载失败/ }).waitFor()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.evaluate(() => { window.knowledgeFixture.failList = false })
  await page.getByRole('button', { name: '知识库', exact: true }).click()
  await page.getByRole('button', { name: '公司制度', exact: true }).waitFor()
  assert.ok(await page.evaluate(() => window.knowledgeFixture.calls.filter(call => call.action === 'list').length >= 2))
})

test('remaining list pages are accessible and the popover fits a narrow window', async t => {
  const page = await openPage(t, { paged: true, width: 390 })
  await page.getByRole('button', { name: '公司制度', exact: true }).waitFor()
  const next = page.getByRole('button', { name: /下一页|加载更多/ })
  await next.click()
  await page.getByRole('button', { name: '产品资料', exact: true }).waitFor()
  const box = await page.getByRole('dialog', { name: '选择知识库' }).boundingBox()
  assert.ok(box.x >= 0 && box.x + box.width <= 391)
  mkdirSync('output/playwright', { recursive: true })
  await page.screenshot({ path: 'output/playwright/knowledge-selector.png' })
  await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('dialog', { name: '选择知识库' }).count(), 0)
})
