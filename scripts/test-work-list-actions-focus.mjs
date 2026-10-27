/* global window, document */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright-core'

const browser = await chromium.launch({
  executablePath: process.env.SEP_PREVIEW_BROWSER ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(process.env.SEP_PREVIEW_URL ?? 'http://127.0.0.1:5174/?preview=workspace')
  const source = await (await page.request.get(new URL('/pages/enterprise/WorkListActions.tsx', page.url()).href)).text()
  const main = await (await page.request.get(new URL('/main.tsx', page.url()).href)).text()
  const reactPath = source.match(/from "([^"]*\/react\.js[^"]*)"/)?.[1]
  const domPath = main.match(/from "([^"]*\/react-dom_client\.js[^"]*)"/)?.[1]
  assert.ok(reactPath && domPath)
  await page.evaluate(async ({ reactPath, domPath }) => {
    const { default: React } = await import(reactPath)
    const { createRoot } = (await import(domPath)).default
    const { WorkListPane } = await import('/pages/enterprise/WorkListPane.tsx')
    const { WorkListActions } = await import('/pages/enterprise/WorkListActions.tsx')
    await import('/styles/work-hub.css')
    const e = React.createElement
    const work = id => ({ id, title: `测试工作 ${id}`, status: 'completed', isActive: false,
      workType: { state: 'resolved', kind: 'conversation' }, messages: [], goal: '测试记录', updatedAt: 1 })
    function Harness() {
      const [works, setWorks] = React.useState(Array.from({ length: 30 }, (_, i) => work(String(i))))
      const [request, setRequest] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [filters, setFilters] = React.useState({ bucket: 'all', workType: 'all', search: '' })
      const dismiss = React.useCallback(() => setRequest(null), [])
      window.focusTest = { reset: ids => setWorks(ids.map(work)) }
      return e('div', { className: 'ent-shell ent-work-shell', style: { height: '100vh' } },
        e('div', { className: 'ent-work-hub list-open', style: { height: '100vh' } },
          e(WorkListPane, { works, records: works, filters, onFilters: setFilters, selectedWorkId: null,
            onSelect() {}, onCreate() {}, onClose() {}, onRetryTypes() {}, menuWorkId: request?.workId,
            onWorkMenu: (workId, trigger, point) => setRequest({ workId, trigger, x: point?.x ?? 200, y: point?.y ?? 200 }) }),
          e(WorkListActions, { works, request, busy, onDismiss: dismiss, onPin: async () => true, onRename: async () => true,
            onDelete: async id => {
              setBusy(true)
              await new Promise(resolve => setTimeout(resolve, 50))
              setWorks(current => current.filter(item => item.id !== id))
              setBusy(false)
              return true
            } })))
    }
    document.getElementById('root').remove()
    const root = document.createElement('div')
    document.body.append(root)
    createRoot(root).render(e(Harness))
  }, { reactPath, domPath })

  const row = id => page.getByRole('button', { name: `测试工作 ${id}，已完成，会话`, exact: true })
  const openDelete = async id => {
    await row(id).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '删除', exact: true }).click()
    await page.getByRole('dialog').waitFor()
    assert.equal(await page.getByRole('button', { name: '取消', exact: true }).evaluate(el => el === document.activeElement), true)
  }
  const assertFocus = async locator => {
    await locator.waitFor()
    await page.waitForFunction(() => !document.querySelector('dialog[open]'))
    assert.equal(await locator.evaluate(el => el === document.activeElement), true)
    assert.equal(await page.getByRole('searchbox').evaluate(el => el === document.activeElement), false)
  }

  await openDelete('14')
  const scrollBefore = await page.locator('.ent-work-list-scroll').evaluate(el => el.scrollTop)
  await page.getByRole('button', { name: '确认删除', exact: true }).click()
  await assertFocus(row('15'))
  const scrollAfter = await page.locator('.ent-work-list-scroll').evaluate(el => el.scrollTop)
  assert.ok(Math.abs(scrollBefore - scrollAfter) < 100, 'deletion must preserve the list position')

  await page.evaluate(() => window.focusTest.reset(['a', 'b']))
  await openDelete('b')
  await page.getByRole('button', { name: '确认删除', exact: true }).click()
  await assertFocus(row('a'))
  await openDelete('a')
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await assertFocus(row('a'))
  await openDelete('a')
  await page.getByRole('button', { name: '确认删除', exact: true }).click()
  await assertFocus(page.getByRole('complementary', { name: '工作列表' }))

  await page.evaluate(() => window.focusTest.reset(['rename']))
  await row('rename').click({ button: 'right' })
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click()
  await page.getByLabel('工作名称', { exact: true }).fill('新名称')
  await page.getByRole('button', { name: '保存名称', exact: true }).click()
  await assertFocus(row('rename'))
  assert.deepEqual(errors, [])
  await mkdir('output/playwright', { recursive: true })
  await page.screenshot({ path: 'output/playwright/work-list-focus.png' })
  console.log('PASS: native dialog deletion/cancel/rename focus; adjacent row and empty-list fallback; scroll position; no page errors')
} finally {
  await browser.close()
}
