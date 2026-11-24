/* global window, document */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

let server
let browser
let base
let entry
before(async () => {
  const executablePath = [process.env.SEP_PREVIEW_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium'].find(path => path && existsSync(path))
  assert.ok(executablePath, 'Set SEP_PREVIEW_BROWSER to an installed Chromium executable')
  server = await createServer({ configFile: resolve('vite.preview.config.ts'), server: { port: 0, strictPort: false } })
  await server.listen()
  base = server.resolvedUrls.local[0]
  const original = await (await fetch(new URL('main.tsx', base))).text()
  entry = original.slice(0, original.indexOf('import App from'))
  browser = await chromium.launch({ executablePath, headless: true })
})
after(async () => { await browser?.close(); await server?.close() })

test('all attachment composers show a file-only drop hint across the editor and toolbar', async () => {
  const page = await browser.newPage()
  const errors = []
  page.setDefaultTimeout(7000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  try {
    await page.addInitScript(() => {
      let listener
      let items = []
      window.fixtureRewrites = []
      window.completeFixtureImport = (composerId, source, name) => {
        const event = { composerId, sessionId: 'drop-session', operationId: name, source }
        listener({ ...event, status: 'started' })
        const supported = name.endsWith('.txt')
        items = [...items, { attachmentId: name, displayName: name, sha256: 'a'.repeat(64), byteLength: 7, mediaType: supported ? 'text/plain' : 'image/png',
          extractionStatus: supported ? 'ready' : 'not-required', extractionSummary: supported ? 'fixture' : undefined }]
        listener({ ...event, status: 'completed' })
      }
      window.electronAPI = {
        beginAttachmentImport: async ({ target }) => ({ success: true, data: { target, sessionId: 'drop-session', status: 'open', attachments: [] } }),
        cancelAttachmentImport: async () => ({ success: true }),
        onAttachmentPaste: callback => { listener = callback; return () => { listener = undefined } },
        listAttachments: async () => ({ success: true, data: items }),
        removeAttachment: async ({ attachmentId }) => { items = items.filter(item => item.attachmentId !== attachmentId); return { success: true } },
        getDefaultWorkspaceDirectory: async () => ({ success: true, path: null }),
        listTaskRuns: async () => ({ success: true, runs: [] }),
        onPiEvent: () => () => {},
        conversationQueue: async () => ({ success: true, queue: { paused: false, failed: null, items: [] } }),
      }
    })
    await page.route(/\/main\.tsx(?:\?.*)?$/, route => route.fulfill({ contentType: 'text/javascript', body: `${entry}
      import '/index.css';
      import '/styles/enterprise.css';
      import '/styles/arrange.css';
      import '/styles/home-v2.css';
      import '/styles/skill-detail.css';
      import { FeedbackProvider } from '/components/feedback/FeedbackProvider.tsx';
      import { HomeAssistantCard } from '/components/enterprise/home/HomeAssistantCard.tsx';
      import { ChatArrange } from '/components/enterprise/arrange/ChatArrange.tsx';
      import { GoalComposer } from '/components/enterprise/arrange/GoalComposer.tsx';
      import { ManualArrange } from '/components/enterprise/arrange/ManualArrange.tsx';
      import { WorkConversation } from '/components/enterprise/WorkTalkDrawer.tsx';
      import { WorkspaceComposer } from '/components/workspace/WorkspaceComposer.tsx';
      import { SkillRewriteComposer } from '/components/enterprise/skills/SkillRewriteComposer.tsx';
      import { ModelCatalogProvider } from '/components/enterprise/ModelCatalogContext.tsx';
      import { SkillRewriteSession } from '/features/enterprise/skill-rewrite-session.ts';
      import { createHomeDraft } from '/features/enterprise/home-draft.ts';
      import { defaultRunSettings } from '/features/enterprise/run-settings.ts';
      const params = new URL(location.href).searchParams;
      const employees = [];
      const busy = params.has('busy');
      const demo = params.has('demo');
      const shared = { employees, busy, settings: defaultRunSettings(), models: [], onSettingsChange() {}, onChooseFolder() {} };
      const skillSession = new SkillRewriteSession();
      const skill = { content: '# Skill', revision: 1, disabled: busy, session: skillSession, manualEdits: [], onCancel() {}, onApply() {}, onUndo() {},
        onRewrite: async input => { window.fixtureRewrites.push(input); throw new Error('生成失败'); } };
      function Composer() {
        const [value, onChange] = React.useState('');
        if (params.has('skill')) return React.createElement(ModelCatalogProvider, { models: [{ modelId: 'test-model', displayName: 'test-model' }] },
          React.createElement('div', { className: 'skill-detail' }, React.createElement(SkillRewriteComposer, skill)));
        if (params.has('home')) return React.createElement('div', { className: 'sep-home' }, React.createElement(HomeAssistantCard, { employees, busy, demo, draft: createHomeDraft(), onSubmit() {}, onCreate() {}, onManageConnectors() {} }));
        if (params.has('auto')) return React.createElement(GoalComposer, { ...shared, value, onChange, submitLabel: '开始编排', submitDisabled: !value, onSubmit() {} });
        if (params.has('manual')) return React.createElement(ManualArrange, { ...shared, seed: { steps: [{ id: 'step', employeeId: '', title: '', input: '', output: '', dependsOn: [] }] }, onSave() {}, onStart() {} });
        if (params.has('existing')) return React.createElement(WorkConversation, { work: { id: 'work', status: 'completed', title: '工作', kind: 'conversation', currentEmployeeId: 'employee', currentEmployeeName: '员工', messages: [] }, workspace: { employees, myEmployees: [], busy, attachmentScopeKey: 'fixture' } });
        if (params.has('legacy')) return React.createElement(WorkspaceComposer, { ...shared, mode: params.has('workflow') ? 'workflow' : 'conversation', draft: { employeeId: '', modelId: '', skillIds: [], workspace: { path: '', displayName: '', accessMode: 'read-write' } }, skills: [], workflows: [], onDraftChange() {}, onConversationSubmit() {}, onWorkflowSubmit() {} });
        return React.createElement(ChatArrange, { ...shared, employeeId: '', onEmployeeChange() {}, onStart() {} });
      }
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(FeedbackProvider, null,
        React.createElement('div', { className: params.has('dark') ? 'ent-shell dark' : 'ent-shell', style: { display: 'block' } }, React.createElement(Composer))));
    ` }))
    const zone = page.locator('[data-attachment-drop-zone]')
    const hint = zone.getByText('松开添加附件')
    const drag = (locator, type, files, toChild = false) => locator.evaluate((element, { type, files, toChild }) => {
      const dataTransfer = new window.DataTransfer()
      if (files) dataTransfer.items.add(new window.File(['fixture'], 'report.txt'))
      else dataTransfer.setData('text/plain', 'fixture')
      const event = new window.DragEvent(type, { dataTransfer, bubbles: true, cancelable: true,
        relatedTarget: toChild ? element.querySelector('textarea') : null })
      return !element.dispatchEvent(event)
    }, { type, files, toChild })
    for (const [query, width] of [['?home', 920], ['?dark', 480], ['?auto&dark', 760], ['?manual', 920], ['?existing&dark', 760], ['?skill', 920], ['?skill&dark', 420]]) {
      await page.setViewportSize({ width, height: 620 })
      await page.goto(new URL(query, base).href)
      await page.locator('[data-attachment-drop-zone]:not([data-attachment-drop-disabled])').waitFor()
      const editor = zone.locator('textarea').first()
      const isSkill = query.includes('skill')
      const addButton = zone.getByRole('button', { name: isSkill ? '引用文件' : '添加文件或连接器' })
      await editor.fill('保留这段草稿')
      assert.equal(await drag(editor, 'dragover', false), false)
      assert.equal(await hint.count(), 0)
      assert.equal(await drag(editor, 'dragenter', true), true)
      await hint.waitFor()
      const bounds = await zone.boundingBox()
      const overlay = await hint.boundingBox()
      assert.ok(bounds && overlay && overlay.x >= bounds.x && overlay.x + overlay.width <= bounds.x + bounds.width)
      assert.equal(await hint.evaluate(element => window.getComputedStyle(element).pointerEvents), 'none')
      assert.equal(await drag(addButton, 'dragover', true), true)
      await drag(zone, 'dragleave', true, true)
      assert.equal(await hint.isVisible(), true)
      await drag(zone, 'dragleave', true)
      await hint.waitFor({ state: 'hidden' })
      await drag(addButton, 'dragenter', true)
      await hint.waitFor()
      assert.equal(await drag(addButton, 'drop', true), true)
      await hint.waitFor({ state: 'hidden' })
      assert.equal(await editor.inputValue(), '保留这段草稿')
      const complete = (source, name) => zone.evaluate((element, { source, name }) => window.completeFixtureImport(element.getAttribute('data-attachment-drop-zone'), source, name), { source, name })
      await complete('drop', 'report.txt')
      await zone.getByRole('button', { name: '移除 report.txt' }).waitFor()
      if (isSkill) {
        const resize = zone.getByRole('button', { name: '调整输入框高度' })
        const before = (await zone.boundingBox()).height
        await resize.press('ArrowDown')
        assert.ok((await zone.boundingBox()).height > before)
        await resize.press('ArrowUp')

        await complete('drop', 'image.png')
        await page.getByText('无法读取「image.png」的文本', { exact: false }).waitFor()
        const send = zone.getByRole('button', { name: '发送调整要求' })
        const zoneBounds = await zone.boundingBox(), sendBounds = await send.boundingBox()
        assert.ok(sendBounds.y + sendBounds.height <= zoneBounds.y + zoneBounds.height)
        assert.equal(await send.isDisabled(), true)
        const remove = zone.getByRole('button', { name: '移除 image.png' })
        await remove.click()
        await remove.waitFor({ state: 'hidden' })
        assert.equal(await editor.inputValue(), '保留这段草稿')
        assert.equal(await page.evaluate(() => window.fixtureRewrites.length), 0)

        await send.click()
        const retry = page.getByRole('button', { name: '重试', exact: true }).last()
        await retry.waitFor()
        await zone.getByRole('button', { name: '移除 report.txt' }).waitFor({ state: 'hidden' })
        assert.deepEqual(await page.evaluate(() => window.fixtureRewrites.map(({ prompt, referenceFiles }) => ({ prompt, referenceFiles }))), [
          { prompt: '保留这段草稿', referenceFiles: { sessionId: 'drop-session', attachments: [{ attachmentId: 'report.txt', sha256: 'a'.repeat(64) }] } },
        ])
        await retry.click()
        await page.waitForFunction(() => window.fixtureRewrites.length === 2)
        assert.equal(await page.evaluate(() => window.fixtureRewrites[1].referenceFiles.attachments[0].attachmentId), 'report.txt')
        await editor.fill('下一轮不附带文件')
        await send.click()
        assert.equal(await page.evaluate(() => window.fixtureRewrites[2].referenceFiles), undefined)
      }
      if (query === '?manual') {
        const stepAttachment = name => zone.getByRole('group', { name: '本步骤使用的附件' }).getByRole('checkbox', { name })
        assert.equal(await stepAttachment('report.txt').isChecked(), false)
        await complete('paste', 'pasted.txt')
        await stepAttachment('pasted.txt').waitFor()
        assert.equal(await stepAttachment('pasted.txt').isChecked(), true)
      }
    }
    for (const query of ['?home&demo', '?busy']) {
      await page.goto(new URL(query, base).href)
      await page.locator('[data-attachment-drop-disabled]').waitFor()
      assert.equal(await drag(zone, 'dragover', true), true)
      assert.equal(await hint.count(), 0)
    }
    for (const query of ['?legacy', '?legacy&workflow']) {
      await page.goto(new URL(query, base).href)
      const legacy = page.getByRole('region', { name: '工作输入' })
      await drag(legacy, 'dragover', true)
      await legacy.getByText('松开添加附件').waitFor()
      assert.equal(await drag(legacy, 'drop', true), true)
      await legacy.getByRole('button', { name: '移除文件report.txt' }).waitFor()
    }
  } catch (error) {
    assert.deepEqual(errors, [])
    throw error
  } finally { await page.close() }
})

test('Windows folder material dialog imports only checked files and fits narrow light and dark views', async () => {
  for (const width of [420, 920]) {
    const page = await browser.newPage({ viewport: { width, height: 580 } })
    page.setDefaultTimeout(7000)
    try {
      await page.addInitScript(() => {
        const fixture = window.materialFixture = { imports: [], previews: 0 }
        const session = { sessionId: 'material-session', status: 'open', attachments: [] }
        const video = { attachmentId: 'video-attachment', displayName: '商品.mp4', byteLength: 4096,
          mediaType: 'video/mp4', extractionStatus: 'not-required', sha256: 'a'.repeat(64), importSource: 'paste-file', warnings: [] }
        window.electronAPI = {
          platform: 'win32', beginAttachmentImport: async () => ({ success: true, data: session }),
          bindAttachmentPaste: input => { fixture.paste = input.onFolderPaste; return () => {} },
          previewAttachmentFolder: async () => { fixture.previews++; return { success: true, data: { previewId: 'preview-one', folderName: '商品素材', truncated: false, candidates: [
            { id: 'video', name: video.displayName, kind: 'video', byteLength: 4096 },
            { id: 'image', name: '正面图.png', kind: 'image', byteLength: 2048 },
            { id: 'large', name: '较大的素材.mp4', kind: 'video', byteLength: 25000000, unavailable: 'too-large' },
          ] } } },
          importAttachmentFolder: async input => { fixture.imports.push(input); return { success: true, data: { ...session, attachments: [video] } } },
          cancelAttachmentImport: async () => ({ success: true }),
        }
      })
      await page.route(/\/main\.tsx(?:\?.*)?$/, route => route.fulfill({ contentType: 'text/javascript', body: `${entry}
        import '/index.css';
        import '/styles/enterprise.css';
        import '/styles/conversation.css';
        import { AttachmentComposer } from '/components/enterprise/attachments/AttachmentComposer.tsx';
        import { FeedbackProvider } from '/components/feedback/FeedbackProvider.tsx';
        ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(FeedbackProvider, null,
          React.createElement('div', { className: '${width === 420 ? 'ent-shell dark' : 'ent-shell'}' },
            React.createElement(AttachmentComposer, { allowFolderPaste: true, target: { kind: 'compose', composerId: 'material-composer' }, onConnectorChange() {} }))));
      ` }))
      await page.goto(base)
      await page.waitForFunction(() => typeof window.materialFixture.paste === 'function')
      await page.evaluate(() => window.materialFixture.paste('trusted-paste'))
      assert.equal(await page.evaluate(() => window.materialFixture.previews), 0)
      const view = page.getByRole('button', { name: '查看素材' })
      const dialog = page.getByRole('dialog', { name: '选择素材' })
      await view.click()
      await dialog.waitFor()
      assert.ok(await dialog.getByRole('checkbox', { name: /较大的素材/ }).isDisabled())
      assert.ok(await dialog.getByRole('button', { name: '添加所选素材' }).isDisabled())
      const bounds = await dialog.boundingBox()
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y >= 0 && bounds.y + bounds.height <= 580)
      await dialog.getByRole('button', { name: '取消' }).click()
      await dialog.waitFor({ state: 'hidden' })
      assert.deepEqual(await page.evaluate(() => window.materialFixture.imports), [])
      await view.click()
      await dialog.getByRole('checkbox', { name: /商品.mp4/ }).check()
      await dialog.getByRole('button', { name: '添加所选素材' }).click()
      await page.getByText(/视频素材/).waitFor()
      assert.deepEqual(await page.evaluate(() => window.materialFixture.imports), [{ sessionId: 'material-session', previewId: 'preview-one', candidateIds: ['video'] }])
    } finally { await page.close() }
  }
})

test('production home composer binds file mentions without sending, and preserves draft ownership', async () => {
  const page = await browser.newPage({ viewport: { width: 736, height: 680 } })
  page.setDefaultTimeout(7_000)
  const browserErrors = []
  page.on('pageerror', error => browserErrors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()) })
  try {
    await page.addInitScript(() => {
      const fixture = window.fileMentionFixture = { selects: [], sent: [], mode: 'file', items: [] }
      const item = (id, name, digit) => ({ attachmentId: id, displayName: name, sha256: digit.repeat(64), byteLength: 12, mediaType: 'text/plain', importSource: 'picker', extractionStatus: 'ready', warnings: [] })
      fixture.items = [item('first', 'budget.txt', '1'), item('second', 'budget.txt', '2')]
      window.electronAPI = {
        beginAttachmentImport: async ({ target }) => ({ success: true, data: { target, sessionId: 'references', status: 'open', attachments: fixture.items } }),
        selectAttachments: async request => {
          fixture.selects.push(request)
          if (fixture.mode === 'cancel') return { success: true, cancelled: true, data: fixture.items }
          if (fixture.mode === 'fail') return { success: false, error: { message: 'Fixture read failed' } }
          if (fixture.mode === 'defer') await new Promise(resolve => { fixture.finish = resolve })
          fixture.items = [...fixture.items, item(`local-${fixture.selects.length}`, 'local.txt', '3')]
          return { success: true, data: fixture.items }
        },
        listAttachments: async () => ({ success: true, data: fixture.items }),
        cancelAttachmentImport: async () => ({ success: true }),
      }
    })
    await page.route(/\/main\.tsx(?:\?.*)?$/, route => route.fulfill({ contentType: 'text/javascript', body: `${entry}
      import '/index.css';
      import '/styles/enterprise.css';
      import { createHomeDraft } from '/features/enterprise/home-draft.ts';
      import { generalAssistant } from '/features/enterprise/general-assistant.ts';
      import { HomeAssistantCard } from '/components/enterprise/home/HomeAssistantCard.tsx';
      import { FeedbackProvider } from '/components/feedback/FeedbackProvider.tsx';
      const inDrawer = new URL(location.href).searchParams.has('drawer');
      const card = React.createElement(HomeAssistantCard, { draft: createHomeDraft(), employees: [generalAssistant([{ allowedModels: ['fixture-model'] }])], busy: false, demo: false,
        onSubmit: async (...args) => { window.fileMentionFixture.sent.push(args); return false }, onCreate() {}, onManageConnectors() {} });
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(FeedbackProvider, null,
        React.createElement('div', { className: inDrawer ? 'ent-shell dark' : 'ent-shell', style: { display: 'block' } },
          inDrawer ? React.createElement('aside', { role: 'dialog', className: 'ent-drawer wide', 'aria-modal': true }, card) : card)));
    ` }))
    await page.goto(base)
    const input = page.getByRole('textbox', { name: '工作需求' })
    const list = page.getByRole('listbox', { name: '可引用文件' })
    const send = page.getByRole('button', { name: '发送需求' })
    const mirror = page.locator('.ent-file-mention-mirror')
    const highlight = mirror.locator('.ent-file-mention-highlight')
    const color = locator => locator.evaluate(element => window.getComputedStyle(element).color)
    const sent = () => page.evaluate(() => window.fileMentionFixture.sent)
    await page.getByRole('button', { name: '移除 budget.txt' }).first().waitFor()
    await input.fill('contact@example.com')
    assert.equal(await list.count(), 0)
    assert.equal(await highlight.count(), 0)
    await input.fill('对比＠bud')
    await list.getByRole('option', { name: /第 2 份附件/ }).waitFor()
    assert.equal(await highlight.count(), 0)
    await input.press('ArrowDown')
    await input.press('Enter')
    assert.equal(await input.inputValue(), '对比@budget.txt ')
    assert.equal(await highlight.textContent(), '@budget.txt')
    assert.equal(await color(highlight), 'rgb(23, 90, 196)')
    assert.equal(await color(mirror), await color(input))
    assert.equal(await mirror.getAttribute('aria-hidden'), 'true')
    await page.getByRole('button', { name: '解除引用 budget.txt' }).waitFor()
    assert.equal(await page.getByRole('button', { name: '移除 budget.txt' }).count(), 1)
    assert.deepEqual(await sent(), [])
    assert.ok(await input.evaluate(element => element === document.activeElement))
    await input.press('Enter')
    await page.waitForFunction(() => window.fileMentionFixture.sent.length === 1)
    const [[, text, options]] = await sent()
    assert.match(text, /@budget\.txt（本轮附件 2）/)
    assert.equal(options.attachmentSessionId, 'references')
    assert.deepEqual(options.attachmentRefs.map(file => file.attachmentId), ['first', 'second'])
    await page.getByRole('button', { name: '解除引用 budget.txt' }).click()
    assert.equal(await highlight.count(), 0)
    assert.equal(await page.getByRole('button', { name: '移除 budget.txt' }).count(), 2)
    await input.press('Control+z')
    await page.getByRole('button', { name: '解除引用 budget.txt' }).waitFor()
    assert.equal(await highlight.textContent(), '@budget.txt')
    assert.equal(await page.getByRole('button', { name: '移除 budget.txt' }).count(), 1)

    const chooseLocal = async mode => {
      await page.evaluate(value => { window.fileMentionFixture.mode = value }, mode)
      await input.fill('')
      await input.fill('阅读 @local')
      await list.getByRole('option', { name: '选择本地文件…' }).click()
    }
    await chooseLocal('cancel')
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'))
    assert.equal(await input.inputValue(), '阅读 @local')
    assert.deepEqual(await page.evaluate(() => window.fileMentionFixture.selects), [{ sessionId: 'references', single: true }])
    await input.press('Escape')
    assert.equal(await list.count(), 0)

    await chooseLocal('fail')
    await page.getByText('Fixture read failed').first().waitFor()
    assert.equal(await send.isEnabled(), false)
    await input.press('Escape')
    await input.press('Enter')
    assert.equal((await sent()).length, 1)

    await chooseLocal('defer')
    await page.waitForFunction(() => typeof window.fileMentionFixture.finish === 'function')
    await input.fill('更改后的草稿')
    await page.evaluate(() => window.fileMentionFixture.finish())
    await page.getByRole('button', { name: '引用文件' }).isEnabled({ timeout: 7_000 })
    await page.waitForFunction(() => !document.querySelector('.ent-file-mention-trigger:disabled'))
    assert.equal(await input.inputValue(), '更改后的草稿')
    assert.equal(await page.getByRole('button', { name: '移除 local.txt' }).count(), 0)
    await input.fill('阅读 @local')
    await list.getByRole('option', { name: /local.txt/ }).click()
    const localChip = page.getByRole('button', { name: '解除引用 local.txt' })
    await localChip.waitFor()
    assert.equal(await page.getByRole('button', { name: '移除 local.txt' }).count(), 0)
    await send.click()
    const [, , localOptions] = (await sent())[1]
    assert.equal(localOptions.attachmentRefs.filter(file => file.attachmentId.startsWith('local-')).length, 1)
    await localChip.click()
    assert.equal(await page.getByRole('button', { name: '移除 local.txt' }).count(), 0)
    await input.press('Control+z')
    await localChip.waitFor()
    assert.equal(await page.getByRole('button', { name: '移除 local.txt' }).count(), 0)

    await page.setViewportSize({ width: 320, height: 600 })
    await page.goto(new URL('?drawer', base).href)
    await page.getByRole('button', { name: '移除 budget.txt' }).first().waitFor()
    await input.fill('@bud')
    const popup = page.getByRole('dialog').locator('.ent-file-mention-popup')
    await popup.waitFor()
    await popup.getByRole('option', { name: /第 1 份附件/ }).click()
    assert.equal(await input.inputValue(), '@budget.txt ')
    assert.equal(await color(highlight), 'rgb(138, 182, 255)')
    await input.dispatchEvent('compositionstart')
    await mirror.waitFor({ state: 'detached' })
    assert.notEqual(await input.evaluate(element => window.getComputedStyle(element).webkitTextFillColor), 'rgba(0, 0, 0, 0)')
    await input.dispatchEvent('compositionend')
    await highlight.waitFor()
    const suffix = ` ${'长文换行和滚动 lots_of_text '.repeat(30)}\n`
    await input.press('Control+End')
    await page.keyboard.insertText(suffix)
    assert.equal(await highlight.textContent(), '@budget.txt')
    assert.equal((await mirror.textContent()).slice(0, -1), await input.inputValue())
    const measure = () => input.evaluate(element => {
      const layer = element.nextElementSibling
      return { inputWidth: element.clientWidth, layerWidth: layer.clientWidth, inputHeight: element.scrollHeight, layerHeight: layer.scrollHeight,
        inputTop: element.scrollTop, layerTop: layer.scrollTop }
    })
    await input.evaluate(element => { element.scrollTop = element.scrollHeight })
    await page.waitForFunction(() => {
      const element = document.querySelector('.ent-file-mention-editor textarea')
      return element.scrollTop > 0 && element.scrollTop === element.nextElementSibling.scrollTop
    })
    const sizes = await measure()
    assert.equal(sizes.inputWidth, sizes.layerWidth)
    assert.equal(sizes.inputHeight, sizes.layerHeight)
    await page.setViewportSize({ width: 410, height: 600 })
    await page.waitForFunction(() => {
      const element = document.querySelector('.ent-file-mention-editor textarea')
      return element.clientWidth === element.nextElementSibling.clientWidth
    })
    const resized = await measure()
    assert.notEqual(resized.inputWidth, sizes.inputWidth)
    assert.equal(resized.inputHeight, resized.layerHeight)
    await page.setViewportSize({ width: 320, height: 600 })
    await input.fill('@bud')
    const bounds = await popup.boundingBox()
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 320 && bounds.y >= 0 && bounds.y + bounds.height <= 600, JSON.stringify(bounds))
    assert.equal(await popup.evaluate(element => window.getComputedStyle(element).backgroundColor), 'rgb(26, 29, 38)')
  } catch (error) {
    throw new Error(`${error.message}\n${browserErrors.join('\n')}`, { cause: error })
  } finally { await page.close() }
})

test('image mentions load visible thumbnails before hover and reuse them for viewport-safe previews', async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 740 } })
  page.setDefaultTimeout(7_000)
  try {
    await page.addInitScript(() => {
      const fixture = window.mentionImageFixture = { requests: [], released: [], revoked: [], deferred: false }
      const canvas = document.createElement('canvas')
      canvas.width = 720
      canvas.height = 480
      const context = canvas.getContext('2d')
      context.fillStyle = '#307d83'
      context.fillRect(0, 0, 720, 480)
      const image = canvas.toDataURL('image/png')
      const bytes = Uint8Array.from(window.atob(image.split(',')[1]), value => value.charCodeAt(0))
      const revoke = URL.revokeObjectURL.bind(URL)
      URL.revokeObjectURL = url => { fixture.revoked.push(url); revoke(url) }
      window.electronAPI = {
        async previewAttachment(input) {
          fixture.requests.push(input)
          if (fixture.deferred) await new Promise(resolve => { fixture.finish = resolve })
          return { success: true, data: { ...input, mediaType: 'image/png', bytes } }
        },
        async previewResultFile(input) {
          fixture.requests.push(input)
          return { success: true, data: { kind: 'image', url: image } }
        },
        async releaseResultFilePreview(input) { fixture.released.push(input); return { success: true } },
      }
    })
    await page.route(/\/main\.tsx(?:\?.*)?$/, route => route.fulfill({ contentType: 'text/javascript', body: `${entry}
      import '/index.css';
      import '/styles/enterprise.css';
      import { FileMentionPicker, FileMentionChips, useFileMention } from '/components/enterprise/attachments/FileMentionPicker.tsx';
      const draft = [{ attachmentId: 'draft-image', displayName: 'draft.png', sha256: 'a'.repeat(64), mediaType: 'image/png' }];
      const candidates = [
        { key: 'history', name: 'history.png', source: '本会话历史', file: { taskId: 'work-1', attachmentId: 'old-image', sha256: 'b'.repeat(64) } },
        { key: 'result', name: 'result.png', source: '本工作成果', file: { taskId: 'work-1', assetId: 'generated-image' } },
        ...Array.from({ length: 12 }, (_, index) => ({ key: 'note-' + index, name: 'note-' + index + '.txt', source: '本工作成果', file: { taskId: 'work-1', assetId: 'note-' + index } })),
        { key: 'last', name: 'last.png', source: '本工作成果', file: { taskId: 'work-1', assetId: 'last-image' } },
      ];
      function Fixture() {
        const input = React.useRef(null);
        const [text, update] = React.useState('');
        const mention = useFileMention({ input, text, update, attachments: draft, attachmentSessionId: 'draft-session', candidates });
        return React.createElement('div', { className: 'ent-shell dark' }, React.createElement('aside', { role: 'dialog', className: 'ent-drawer wide', 'aria-modal': true, style: { animation: 'none' } },
          React.createElement('div', { style: { marginTop: 'auto', padding: '0 12px 50px' } },
            React.createElement('textarea', { ref: input, value: text, ...mention.editorAria, 'aria-label': '会话', style: { display: 'block', width: '100%' }, onChange: e => mention.change(e.currentTarget), onKeyDown: mention.keyDown }),
            React.createElement(FileMentionChips, { mention }), React.createElement(FileMentionPicker, { mention }))));
      }
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Fixture));
    ` }))
    await page.goto(base)
    const input = page.getByRole('textbox', { name: '会话' })
    const dialog = page.getByRole('dialog')
    const preview = dialog.locator('.ent-file-mention-image-preview')
    const list = dialog.getByRole('listbox', { name: '可引用文件' })
    const loaded = async locator => locator.evaluate(image => image.decode())
    await input.fill('@')
    const draft = list.getByRole('option', { name: 'draft.png' })
    const history = list.getByRole('option', { name: 'history.png' })
    const result = list.getByRole('option', { name: 'result.png' })
    const last = list.getByRole('option', { name: 'last.png' })
    const thumbnail = draft.locator('img')
    await Promise.all([thumbnail, history.locator('img'), result.locator('img')].map(loaded))
    assert.equal((await thumbnail.boundingBox()).width, 48)
    assert.equal(await last.locator('img').count(), 0)
    assert.equal(await page.evaluate(() => window.mentionImageFixture.requests.length), 3)
    assert.equal(await preview.count(), 0)
    await draft.hover()
    await loaded(preview.locator('img'))
    const wide = await preview.boundingBox()
    const menu = await dialog.locator('.ent-file-mention-popup').boundingBox()
    assert.ok(wide.width >= 300 && wide.x + wide.width < menu.x, JSON.stringify({ wide, menu }))
    assert.equal(await input.inputValue(), '@')
    assert.ok(await input.evaluate(element => element === document.activeElement))

    await history.hover()
    await loaded(preview.locator('img'))
    await result.hover()
    await loaded(preview.locator('img'))
    assert.equal(await thumbnail.count(), 1)
    assert.equal(await page.evaluate(() => window.mentionImageFixture.requests.length), 3)
    await page.mouse.move(0, 0)
    await preview.waitFor({ state: 'hidden' })
    await list.locator('.ent-file-mention-list').evaluate(element => { element.scrollTop = element.scrollHeight })
    await loaded(last.locator('img'))
    assert.equal(await preview.count(), 0)
    assert.equal(await thumbnail.count(), 0)
    assert.equal(await page.evaluate(() => window.mentionImageFixture.requests.at(-1).assetId), 'last-image')
    await input.press('Escape')
    await preview.waitFor({ state: 'hidden' })
    await page.waitForFunction(() => window.mentionImageFixture.released.length === 2)

    await page.setViewportSize({ width: 320, height: 600 })
    await input.fill('@draft')
    await draft.hover()
    await loaded(preview.locator('img'))
    const narrow = await preview.boundingBox()
    assert.ok(narrow.width > 200 && narrow.x >= 0 && narrow.x + narrow.width <= 320 && narrow.y >= 0 && narrow.y + narrow.height <= 600, JSON.stringify(narrow))
    assert.equal(await preview.evaluate(element => window.getComputedStyle(element).backgroundColor), 'rgb(26, 29, 38)')
    await draft.click()
    await preview.waitFor({ state: 'hidden' })
    const chip = dialog.getByRole('button', { name: '解除引用 draft.png' })
    await chip.hover()
    await loaded(preview.locator('img'))
    const label = await chip.boundingBox()
    const chipPreview = await preview.boundingBox()
    assert.ok(chipPreview.y + chipPreview.height < label.y, JSON.stringify({ chipPreview, label }))
    await input.hover()
    await preview.waitFor({ state: 'hidden' })
    assert.equal(await input.inputValue(), '@draft.png ')

    const revoked = await page.evaluate(() => {
      window.mentionImageFixture.deferred = true
      return window.mentionImageFixture.revoked.length
    })
    await chip.hover()
    await page.waitForFunction(() => typeof window.mentionImageFixture.finish === 'function')
    await input.hover()
    await page.evaluate(() => window.mentionImageFixture.finish())
    assert.equal(await preview.count(), 0)
    assert.equal(await page.evaluate(() => window.mentionImageFixture.revoked.length), revoked)
  } finally { await page.close() }
})

async function openFixture(page, { fail = false, deferred = false, assets = false } = {}) {
  await page.addInitScript(({ fail, deferred }) => {
    const fixture = window.attachmentPreviewFixture = { calls: [], actions: [], created: [], revoked: [], fail, deferred }
    const create = URL.createObjectURL.bind(URL)
    const revoke = URL.revokeObjectURL.bind(URL)
    URL.createObjectURL = blob => { const url = create(blob); fixture.created.push(url); return url }
    URL.revokeObjectURL = url => { fixture.revoked.push(url); revoke(url) }
    const canvas = document.createElement('canvas')
    canvas.width = 1600; canvas.height = 900
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#d1e7db'; ctx.fillRect(0, 0, 1600, 900)
    ctx.fillStyle = '#17352a'; ctx.font = '48px sans-serif'; ctx.fillText('Attachment preview', 160, 200)
    const bytes = Uint8Array.from(window.atob(canvas.toDataURL('image/png').split(',')[1]), c => c.charCodeAt(0))
    canvas.width = 640; canvas.height = 480
    ctx.fillStyle = 'rgba(255, 32, 16, 0.5)'; ctx.fillRect(0, 0, 320, 240)
    const outputBytes = Uint8Array.from(window.atob(canvas.toDataURL('image/png').split(',')[1]), c => c.charCodeAt(0))
    window.electronAPI = {
      revealResultFile: async file => { fixture.actions.push({ action: 'reveal', file }); return { success: true } },
      runResultFileAction: async action => { fixture.actions.push(action); return { success: true } },
      previewAttachment: async input => {
      fixture.calls.push(input)
      if (fixture.deferred) await new Promise(resolve => { fixture.resolve = resolve })
      if (fixture.fail) return { success: false, error: { message: 'Unavailable' } }
      return { success: true, data: { ...input, mediaType: 'image/png', bytes, width: 1600, height: 900 } }
    }, getTaskMedia: async taskId => ({ success: true, data: {
      capabilities: null, selectedReferenceIds: [], archived: false, jobs: [], assets: [
        { taskId, localAssetId: 'reference', source: 'reference', status: 'SAVED', mime: 'image/png', width: 1600, height: 900 },
        { taskId, localAssetId: 'output', source: 'output', status: 'SAVED', mime: 'image/png', width: 640, height: 480 },
      ],
    } }), previewMediaAsset: async ({ assetId }) => ({ success: true, data: { mime: 'image/png', bytes: assetId === 'output' ? outputBytes : bytes } }) }
  }, { fail, deferred })
  await page.route(/\/main\.tsx(?:\?.*)?$/, route => route.fulfill({ contentType: 'text/javascript', body: `${entry}
    import '/index.css';
    import '/styles/enterprise.css';
    import '/styles/arrange.css';
    import '/components/workspace/media-artifacts.css';
    import { ConversationMessagesView } from '/components/enterprise/ConversationMessages.tsx';
    import { MediaArtifactsPanel } from '/components/workspace/MediaArtifactsPanel.tsx';
    import { FileAttachmentTarget } from '/components/workspace/file-menu-actions.ts';
    import { FeedbackProvider } from '/components/feedback/FeedbackProvider.tsx';
    const base = { byteLength: 2048, sha256: 'a'.repeat(64), importSource: 'picker', extractionStatus: 'not-required', warnings: [] };
    const work = { id: 'task-images', messages: [{ id: 'message', role: 'user', content: 'Image reference', createdAt: 1, attachments: [
      { ...base, attachmentId: 'image', displayName: 'reference-with-a-long-file-name-that-must-wrap.png', mediaType: 'image/png', width: 1600, height: 900 },
      { ...base, attachmentId: 'pdf', displayName: 'brief.pdf', mediaType: 'application/pdf' },
    ] }] };
    const root = ReactDOM.createRoot(document.getElementById('root'));
    window.unmountFixture = () => root.unmount();
    root.render(React.createElement('main', { className: 'ent-shell', style: { padding: '24px', minHeight: '100vh' } },
      React.createElement(FeedbackProvider, null,
        React.createElement(FileAttachmentTarget.Provider, { value: async file => window.attachmentPreviewFixture.actions.push({ action: 'attach', file }) },
          ${assets ? `React.createElement(MediaArtifactsPanel, { taskId: work.id })` : `React.createElement(ConversationMessagesView, { work, employees: [], preparing: false, runs: [], loading: false, error: null, onReload() {} })`}))));
  ` }))
  await page.goto(base)
}

async function readClipboard(read, accepts) {
  const deadline = Date.now() + 5000
  do {
    const value = await read()
    if (accepts(value)) return value
    await delay(50)
  } while (Date.now() < deadline)
  assert.fail('Expected clipboard data was not written')
}

async function assertImageClipboard(page, { width = 1600, height = 900, alpha = 255 } = {}) {
  await page.context().grantPermissions(['clipboard-read'])
  const copiedImage = await readClipboard(() => page.evaluate(async () => {
    const item = (await window.navigator.clipboard.read()).find(item => item.types.includes('image/png'))
    if (!item) return null
    const blob = await item.getType('image/png').catch(error => {
      if (error.name === 'InvalidStateError') return null // The copy completed between read() and getType().
      throw error
    })
    if (!blob) return null
    const bitmap = await window.createImageBitmap(blob)
    const canvas = new window.OffscreenCanvas(1, 1)
    const context = canvas.getContext('2d')
    context.drawImage(bitmap, 0, 0)
    const result = { width: bitmap.width, height: bitmap.height, pixel: Array.from(context.getImageData(0, 0, 1, 1).data) }
    bitmap.close()
    return result
  }), Boolean)
  assert.deepEqual({ width: copiedImage.width, height: copiedImage.height, alpha: copiedImage.pixel[3] }, { width, height, alpha })
  if (alpha === 255) assert.deepEqual(copiedImage.pixel, [209, 231, 219, 255])
}

async function seedTextClipboard(page) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.evaluate(() => window.navigator.clipboard.writeText('before-preview-copy'))
  await page.context().clearPermissions()
}

for (const width of [1280, 420]) {
  test(`image attachments open, zoom and close without overflow at ${width}px`, async t => {
    const page = await browser.newPage({ viewport: { width, height: 800 } })
    t.after(() => page.close())
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await openFixture(page)
    await page.waitForFunction(() => document.querySelector('.ent-message-attachment-preview img')?.naturalWidth > 0)
    assert.equal(await page.getByText('brief.pdf', { exact: true }).count(), 1)
    assert.equal(await page.evaluate(() => window.attachmentPreviewFixture.calls.length), 1)
    assert.deepEqual(await page.evaluate(() => window.attachmentPreviewFixture.calls[0]), { taskId: 'task-images', attachmentId: 'image', sha256: 'a'.repeat(64) })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
    await mkdir('output/playwright', { recursive: true })
    await page.screenshot({ path: `output/playwright/conversation-attachment-${width}.png`, fullPage: true })
    await page.locator('.ent-message-attachment-preview').click()
    const dialog = page.getByRole('dialog', { name: /图片预览/ })
    await dialog.waitFor()
    assert.equal(await dialog.locator('img').evaluate(img => img.naturalWidth), 1600)
    await page.getByRole('button', { name: '放大图片', exact: true }).click()
    assert.match(await dialog.innerText(), /100%/)
    await page.getByRole('button', { name: '缩小图片', exact: true }).click()
    assert.match(await dialog.innerText(), /75%/)
    await page.getByRole('button', { name: '适应窗口', exact: true }).click()
    await page.screenshot({ path: `output/playwright/conversation-attachment-dialog-${width}.png` })
    await page.keyboard.press('Escape')
    assert.equal(await dialog.count(), 0)
    assert.equal(await page.locator('.ent-message-attachment-preview').evaluate(element => element === document.activeElement), true)
    await page.evaluate(() => window.unmountFixture())
    assert.deepEqual(await page.evaluate(() => window.attachmentPreviewFixture.revoked), await page.evaluate(() => window.attachmentPreviewFixture.created))
    assert.deepEqual(errors, [])
  })
}

test('copy menu writes the full message and a full-size PNG to the clipboard', async t => {
  const page = await browser.newPage({ viewport: { width: 420, height: 800 } })
  t.after(() => page.close())
  await openFixture(page)
  const message = page.getByText('Image reference', { exact: true })
  const thumbnail = page.locator('.ent-message-attachment-preview')
  const menu = page.getByRole('menu')
  await message.click({ button: 'right' })
  await menu.getByRole('menuitem', { name: '复制文本' }).click()
  await menu.waitFor({ state: 'hidden' })
  await page.context().grantPermissions(['clipboard-read'])
  await readClipboard(() => page.evaluate(() => window.navigator.clipboard.readText()), text => text === 'Image reference')
  await page.context().clearPermissions()

  await page.waitForFunction(() => document.querySelector('.ent-message-attachment-preview img')?.naturalWidth > 0)
  await thumbnail.locator('img').click({ button: 'right', position: { x: 235, y: 60 } })
  const copy = menu.getByRole('menuitem', { name: '复制图片' })
  await copy.waitFor()
  const box = await menu.boundingBox()
  assert.ok(box.x >= 0 && box.x + box.width <= 420)
  await copy.click()
  await assertImageClipboard(page)
  assert.equal(await page.getByRole('dialog', { name: /图片预览/ }).count(), 0)

  await message.press('Shift+F10')
  await menu.getByRole('menuitem', { name: '复制文本' }).waitFor()
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'hidden' })
  assert.equal(await message.evaluate(element => document.activeElement === element), true)
  await thumbnail.click()
  const dialog = page.getByRole('dialog', { name: /图片预览/ })
  const largeImage = dialog.locator('img')
  const dialogMenu = dialog.getByRole('menu', { name: '文件操作' })
  await dialog.getByRole('button', { name: '放大图片', exact: true }).click()
  await largeImage.evaluate(img => img.decode())
  await largeImage.press('Shift+F10')
  await dialogMenu.waitFor()
  await page.keyboard.press('Escape')
  await dialogMenu.waitFor({ state: 'hidden' })
  assert.equal(await dialog.isVisible(), true)
  assert.equal(await largeImage.evaluate(img => img === document.activeElement), true)
  await seedTextClipboard(page)
  await largeImage.click({ button: 'right' })
  await dialogMenu.getByRole('menuitem', { name: '复制图片' }).click()
  await assertImageClipboard(page)
  await seedTextClipboard(page)
  await dialog.getByRole('button', { name: '复制图片', exact: true }).click()
  await assertImageClipboard(page)
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
})

test('failed previews retain details and can be retried', async t => {
  const page = await browser.newPage()
  t.after(() => page.close())
  await openFixture(page, { fail: true })
  await page.getByText('预览不可用', { exact: true }).waitFor()
  assert.equal(await page.getByText('1600 × 900', { exact: true }).count(), 1)
  await page.evaluate(() => { window.attachmentPreviewFixture.fail = false })
  await page.getByRole('button', { name: '重新读取图片', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.ent-message-attachment-preview img')?.naturalWidth > 0)
  assert.equal(await page.evaluate(() => window.attachmentPreviewFixture.calls.length), 2)
})

test('files and images expose the same actions, including from the enlarged preview', async t => {
  const page = await browser.newPage({ viewport: { width: 420, height: 800 } })
  t.after(() => page.close())
  await openFixture(page)
  const file = page.getByText('brief.pdf', { exact: true })
  const menu = page.getByRole('menu', { name: '文件操作' })
  const actions = [['打开文件夹', 'reveal'], ['在默认应用打开', 'open'], ['添加到对话框', 'attach'], ['复制路径', 'copy-path'], ['另存为', 'save-as']]
  for (const [label] of actions) {
    await file.click({ button: 'right' })
    assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), actions.map(([name]) => name))
    await menu.getByRole('menuitem', { name: label }).click()
  }
  const thumbnail = page.locator('.ent-message-attachment-preview')
  await thumbnail.click()
  const dialog = page.getByRole('dialog', { name: /图片预览/ })
  await dialog.locator('img').evaluate(img => img.decode())
  await dialog.locator('img').press('Shift+F10')
  assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), [...actions.map(([name]) => name), '复制图片'])
  await page.keyboard.press('ArrowDown')
  assert.equal(await menu.getByRole('menuitem', { name: '在默认应用打开' }).evaluate(element => document.activeElement === element), true)
  await menu.getByRole('menuitem', { name: '添加到对话框' }).click()
  await dialog.waitFor({ state: 'hidden' })
  assert.deepEqual(await page.evaluate(() => window.attachmentPreviewFixture.actions.map(({ action, file }) => [action, file.attachmentId])),
    [...actions.map(([, action]) => [action, 'pdf']), ['attach', 'image']])
})

test('asset grids copy the selected reference or result without losing dimensions or transparency', async t => {
  const page = await browser.newPage({ viewport: { width: 420, height: 800 } })
  t.after(() => page.close())
  await openFixture(page, { assets: true })
  const reference = page.getByRole('button', { name: '放大查看参考图 1', exact: true }).locator('img')
  const output = page.getByRole('button', { name: '放大查看成果 1', exact: true })
  await reference.evaluate(img => img.decode())
  await seedTextClipboard(page)
  await reference.click({ button: 'right' })
  await page.getByRole('menuitem', { name: '复制图片', exact: true }).click()
  await assertImageClipboard(page)
  await seedTextClipboard(page)
  await output.click()
  const dialog = page.getByRole('dialog', { name: '图片大图预览' })
  await dialog.getByRole('button', { name: '复制图片', exact: true }).click()
  await assertImageClipboard(page, { width: 640, height: 480, alpha: 128 })
  assert.equal(await dialog.getByRole('button', { name: '导出图片', exact: true }).isEnabled(), true)
})

test('late preview responses do not create URLs after unmount', async t => {
  const page = await browser.newPage()
  t.after(() => page.close())
  await openFixture(page, { deferred: true })
  await page.waitForFunction(() => typeof window.attachmentPreviewFixture.resolve === 'function')
  await page.evaluate(() => { window.unmountFixture(); window.attachmentPreviewFixture.resolve() })
  assert.deepEqual(await page.evaluate(() => window.attachmentPreviewFixture.created), [])
})
