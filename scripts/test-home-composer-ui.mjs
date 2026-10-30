/* global window, document */
// Real home composer and owner with controlled IPC; does not contact a platform or run tasks.
import assert from 'node:assert/strict'
import { log } from 'node:console'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const server = await createServer({ configFile: 'vite.preview.config.ts', logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } })
let browser
try {
  await server.listen()
  const origin = server.resolvedUrls.local[0]
  const main = await (await fetch(new URL('main.tsx', origin))).text()
  const entry = main.slice(0, main.indexOf('import App from'))
  const pageErrors = []
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.route(/\/main\.tsx(?:\?.*)?$/, route => route.fulfill({ contentType: 'text/javascript', body: `${entry}
    import '/index.css';
    import '/styles/home-v2.css';
    import { FeedbackProvider } from '/components/feedback/FeedbackProvider.tsx';
    import { HomeAssistantCard } from '/components/enterprise/home/HomeAssistantCard.tsx';
    import { useHomeDraftOwner } from '/features/enterprise/home-draft.ts';
    import { homePreviewEmployees } from '/preview/home-fixtures.ts';
    const attachment = { attachmentId: 'file-1', displayName: '季度报告.pdf', sha256: 'a'.repeat(64), mediaType: 'application/pdf', byteLength: 120, importSource: 'picker', extractionStatus: 'ready', warnings: [] };
    window.homeCalls = { begins: [], selects: [], cancels: [], submits: [], removes: [], failSelect: false };
    const items = new Map();
    window.electronAPI = {
      beginAttachmentImport: async ({ target }) => { const id = 'session-' + (window.homeCalls.begins.length + 1); window.homeCalls.begins.push(id); items.set(id, []); return { success: true, data: { sessionId: id, status: 'open', target, attachments: [] } } },
      selectAttachments: async ({ sessionId }) => { window.homeCalls.selects.push(sessionId); if (window.homeCalls.failSelect) return { success: false, error: { message: '测试选择附件失败' } }; items.set(sessionId, [attachment]); return { success: true, data: [attachment] } },
      listAttachments: async ({ sessionId }) => ({ success: true, data: items.get(sessionId) || [] }),
      removeAttachment: async ({ sessionId, attachmentId }) => { window.homeCalls.removes.push(attachmentId); items.set(sessionId, []); return { success: true } },
      cancelAttachmentImport: async ({ sessionId }) => { window.homeCalls.cancels.push(sessionId); return { success: true } },
      bindAttachmentPaste: binding => { window.homeBinding = binding; return () => { if (window.homeBinding === binding) window.homeBinding = null } },
    };
    function Owner() {
      const draft = useHomeDraftOwner();
      const [home, setHome] = React.useState(true);
      window.homeSnapshot = () => ({ text: draft.text, employeeId: draft.employeeId, epoch: draft.epoch, session: draft.attachment.session?.sessionId });
      const submit = (id, text, options) => { window.homeCalls.submits.push({ id, text, options }); return new Promise(resolve => { window.resolveHomeSubmit = resolve }) };
      return React.createElement('main', { className: 'sep-home' },
        React.createElement('button', { onClick: () => setHome(value => !value) }, home ? '离开首页' : '返回首页'),
        home ? React.createElement(HomeAssistantCard, { employees: homePreviewEmployees, draft, demo: false, busy: false, onCreate: () => {}, onSubmit: submit }) : null);
    }
    function Fixture() { const [scope, setScope] = React.useState(0); window.resetHomeOwner = () => setScope(value => value + 1); return React.createElement(Owner, { key: scope }) }
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null, React.createElement(FeedbackProvider, null, React.createElement(Fixture))));
  ` }))
  await page.goto(origin)
  const input = page.getByRole('textbox', { name: '工作需求' })
  await input.waitFor({ timeout: 10000 }).catch(error => { throw new Error(`${error.message}; renderer errors: ${pageErrors.join('; ')}`) })
  await input.fill('整理本季度经营数据')
  await page.getByRole('button', { name: '添加附件', exact: true }).click()
  await page.getByTitle('季度报告.pdf', { exact: true }).waitFor()
  await page.getByRole('button', { name: '添加附件', exact: true }).click()
  const selected = await page.evaluate(() => window.homeCalls.selects)
  assert.equal(selected.length, 2)
  assert.equal(selected[0], selected[1], 'repeated file selection reuses the import session')
  assert.equal(await page.getByRole('button', { name: '上下文', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '截图', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '上传文件', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '添加附件', exact: true }).count(), 1)
  assert.equal(await page.getByRole('button', { name: '语音输入', exact: true }).count(), 1)
  await page.getByRole('button', { name: '选择员工', exact: true }).click()
  await page.getByRole('textbox', { name: '搜索员工' }).fill('爆品')
  const chosen = page.getByRole('dialog').locator('.sep-home-picker-list button').first()
  await chosen.click()
  const beforeNavigation = await page.evaluate(() => ({ snapshot: window.homeSnapshot(), begins: window.homeCalls.begins.length, cancels: window.homeCalls.cancels.length }))
  await page.getByRole('button', { name: '离开首页' }).click()
  await page.getByRole('button', { name: '返回首页' }).click()
  await input.waitFor()
  assert.equal(await input.inputValue(), '整理本季度经营数据')
  assert.deepEqual(await page.evaluate(() => window.homeSnapshot()), beforeNavigation.snapshot)
  assert.equal(await page.evaluate(() => window.homeCalls.begins.length), beforeNavigation.begins)
  assert.equal(await page.evaluate(() => window.homeCalls.cancels.length), beforeNavigation.cancels)
  await page.getByTitle('季度报告.pdf', { exact: true }).waitFor()
  // Trusted paste text is accepted only against the current editor revision.
  const accepted = await page.evaluate(() => {
    const version = Number(document.querySelector('[data-editor-version]').dataset.editorVersion)
    return window.homeBinding.onPasteEdit({ text: '请', selectionStart: 0, selectionEnd: 0, editorVersion: version })
  })
  assert.equal(accepted, true)
  await page.waitForFunction(() => document.querySelector('[aria-label="工作需求"]').value === '请整理本季度经营数据')
  assert.equal(await input.inputValue(), '请整理本季度经营数据')
  assert.equal(await page.evaluate(() => window.homeBinding.onPasteEdit({ text: '旧事件', selectionStart: 0, selectionEnd: 0, editorVersion: -1 })), false)
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 })
  assert.equal(await page.evaluate(() => window.homeCalls.submits.length), 0, 'IME confirmation must not send')
  await input.press('Shift+Enter')
  assert.equal(await page.evaluate(() => window.homeCalls.submits.length), 0, 'Shift+Enter inserts a line break')
  await input.press('Enter')
  await page.waitForFunction(() => window.homeCalls.submits.length === 1)
  const first = await page.evaluate(() => window.homeCalls.submits[0])
  assert.equal(first.id, beforeNavigation.snapshot.employeeId)
  assert.equal(first.text, '请整理本季度经营数据')
  assert.deepEqual(first.options.attachmentRefs, [{ attachmentId: 'file-1', sha256: 'a'.repeat(64) }])
  assert.equal(first.options.attachmentSessionId, selected[0])
  await page.evaluate(() => window.resolveHomeSubmit(false))
  await page.getByRole('alert').waitFor()
  assert.equal((await page.evaluate(() => window.homeSnapshot())).text.trim(), '请整理本季度经营数据')
  await page.getByRole('button', { name: '发送需求' }).evaluate(button => { button.click(); button.click() })
  await page.waitForFunction(() => window.homeCalls.submits.length === 2)
  assert.equal(await page.evaluate(() => window.homeCalls.submits.length), 2, 'submission lock blocks duplicate clicks')
  await page.evaluate(() => window.resolveHomeSubmit(true))
  await page.waitForFunction(() => window.homeSnapshot().text === '')
  assert.equal(await input.inputValue(), '')
  assert.equal(await page.getByText('已添加上下文', { exact: true }).count(), 0)
  assert.equal(await page.getByTitle('季度报告.pdf', { exact: true }).count(), 0)
  await page.getByRole('button', { name: '添加附件', exact: true }).click()
  await page.evaluate(() => { window.homeCalls.failSelect = true })
  await page.getByRole('button', { name: '添加附件', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: '测试选择附件失败' }).waitFor()
  await page.waitForFunction(() => Boolean(window.homeSnapshot().session))
  const abandoned = await page.evaluate(() => window.homeSnapshot().session)
  await page.evaluate(() => window.resetHomeOwner())
  await page.waitForFunction(id => window.homeCalls.cancels.includes(id), abandoned)
  assert.equal(await input.inputValue(), '', 'new login scope owns an empty draft')
  assert.deepEqual(pageErrors, [])
  log('PASS home composer: shared attachments, navigation retention, single upload entry, selected employee, revisioned paste, IME, failure retry, duplicate lock, success reset and owner cleanup')
} finally {
  await browser?.close()
  await server.close()
}
