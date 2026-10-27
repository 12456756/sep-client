/* global window, document */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
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
  browser = await chromium.launch({ executablePath, headless: true })
  await mkdir('output/playwright', { recursive: true })
})
after(async () => { await browser?.close(); await server?.close() })

for (const mode of ['chat', 'goal']) {
  for (const width of [1280, 420]) {
    test(`${mode} at ${width}px keeps attachment cards inside the composer above the text`, async t => {
      const page = await browser.newPage({ viewport: { width, height: 800 } })
      t.after(() => page.close())
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.addInitScript(() => {
        const fixture = window.attachmentFixture = { calls: [], items: [], activeBindings: 0 }
        const ok = data => ({ success: true, data })
        window.electronAPI = {
          beginSpeechRecording: async () => ok({}),
          beginAttachmentImport: async ({ target }) => {
            const sessionId = `session-${fixture.calls.length}`
            fixture.calls.push('begin')
            return ok({ sessionId, target, status: 'open', attachments: [] })
          },
          cancelAttachmentImport: async () => { fixture.calls.push('cancel'); return ok(null) },
          bindAttachmentPaste: () => { fixture.activeBindings++; return () => { fixture.activeBindings-- } },
          selectAttachments: async () => {
            fixture.calls.push('select')
            fixture.items = ['requirements.pdf', `${'long-file-name-'.repeat(14)}.md`, 'data.csv'].map((displayName, index) => ({
              attachmentId: `file-${index}`, displayName, byteLength: 2048, extractionStatus: 'ready',
            }))
            return ok(fixture.items)
          },
          removeAttachment: async ({ attachmentId }) => {
            fixture.calls.push('remove')
            fixture.items = fixture.items.filter(item => item.attachmentId !== attachmentId)
            return ok(null)
          },
        }
      })
      await page.route(/\/main\.tsx(?:\?.*)?$/, route => route.fulfill({ contentType: 'text/javascript', body: `${entry}
        import '/index.css';
        import '/styles/enterprise.css';
        import '/styles/arrange.css';
        import { ChatArrange } from '/components/enterprise/arrange/ChatArrange.tsx';
        import { GoalComposer } from '/components/enterprise/arrange/GoalComposer.tsx';
        import { defaultRunSettings } from '/features/enterprise/run-settings.ts';
        import { FeedbackProvider } from '/components/feedback/FeedbackProvider.tsx';
        const noop = () => {};
        const props = { busy: false, settings: defaultRunSettings(), models: ['deepseek-v4-flash'], onSettingsChange: noop, onChooseFolder: async () => null };
        const content = ${mode === 'chat'
          ? "React.createElement(ChatArrange, { ...props, employees: [], employeeId: '', onEmployeeChange: noop, onStart: noop })"
          : "React.createElement('section', { className: 'ent-arr-auto' }, React.createElement(GoalComposer, { ...props, value: '', onChange: noop, placeholder: 'Work goal', submitLabel: 'Submit', submitDisabled: true, onSubmit: noop }))"};
        ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(FeedbackProvider, null, React.createElement(React.StrictMode, null,
          React.createElement('main', { className: 'ent-shell', style: { padding: '24px', height: '100vh' } },
            React.createElement('div', { className: 'ent-arr', style: { padding: 0 } }, content)))));` }))
      await page.goto(base)
      const button = page.getByRole('button', { name: '添加附件', exact: true })
      await button.waitFor()
      await page.waitForFunction(() => document.querySelector('.ent-attachment-button')?.disabled === false)
      assert.equal(await button.innerText(), '')
      assert.equal(await button.evaluate(element => element.closest('[class$="bar"]').firstElementChild.contains(element)), true)
      assert.equal(await page.locator('.ent-chat-send, .ent-goal-send').evaluate(element => element.getBoundingClientRect().width), 36)
      assert.equal(await page.evaluate(() => window.attachmentFixture.activeBindings), 1)
      await button.click()
      await page.waitForFunction(() => document.querySelectorAll('.ent-attachment-item').length === 3)
      const geometry = await page.evaluate(() => {
        const input = document.querySelector('.ent-chat-ask, .ent-goal')
        const rect = input.getBoundingClientRect()
        const list = input.querySelector('.ent-attachment-list').getBoundingClientRect()
        const text = input.querySelector('textarea').getBoundingClientRect()
        const cards = [...input.querySelectorAll('.ent-attachment-item')].map(item => {
          const card = item.getBoundingClientRect()
          const close = item.querySelector('button').getBoundingClientRect()
          return card.left >= rect.left && card.right <= rect.right && close.right <= rect.right
        })
        return { inside: list.top >= rect.top, above: list.bottom <= text.top, cards, overflow: document.documentElement.scrollWidth > window.innerWidth }
      })
      assert.equal(geometry.inside, true)
      assert.equal(geometry.above, true)
      assert.ok(geometry.cards.every(Boolean))
      assert.equal(geometry.overflow, false)
      if (mode === 'chat') assert.equal(await page.locator('.ent-arr-empty-state').isVisible(), false)
      await page.screenshot({ path: `output/playwright/attachments-${mode}-${width}.png`, fullPage: true })
      for (let remaining = 2; remaining >= 0; remaining--) {
        await page.locator('.ent-attachment-item button').first().click()
        await page.waitForFunction(count => document.querySelectorAll('.ent-attachment-item').length === count, remaining)
      }
      assert.equal(await page.locator('.ent-composer-attachments').isVisible(), false)
      assert.equal(await button.isEnabled(), true)
      assert.equal(await page.evaluate(() => window.attachmentFixture.calls.filter(call => call === 'select').length), 1)
      assert.deepEqual(errors, [])
    })
  }
}
