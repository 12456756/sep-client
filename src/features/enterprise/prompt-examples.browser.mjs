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
  mkdirSync('output/playwright', { recursive: true })
})
after(async () => { await browser?.close(); await server?.close() })

for (const mode of ['chat', 'auto', 'manual']) {
  for (const width of [1280, 420]) {
    test(`${mode} at ${width}px centers examples under the empty state and fills the composer without submitting`, async t => {
      const page = await browser.newPage({ viewport: { width, height: width === 1280 ? 850 : 640 }, reducedMotion: 'reduce' })
      t.after(() => page.close())
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.addInitScript(() => {
        window.promptSubmissions = 0
        window.electronAPI = {
          beginAttachmentImport: async ({ target }) => ({ success: true, data: { sessionId: 'fixture-session', target, status: 'open', attachments: [] } }),
          cancelAttachmentImport: async () => ({ success: true }),
          bindAttachmentPaste: () => () => {},
          onArrangementPlanningEvent: () => () => {},
        }
      })
      await page.route(/\/main\.tsx(?:\?.*)?$/, route => route.fulfill({ contentType: 'text/javascript', body: `${entry}
        import '/index.css';
        import '/styles/enterprise.css';
        import '/styles/arrange.css';
        import { ChatArrange } from '/components/enterprise/arrange/ChatArrange.tsx';
        import { AutoArrange } from '/components/enterprise/arrange/AutoArrange.tsx';
        import { ManualArrange } from '/components/enterprise/arrange/ManualArrange.tsx';
        import { defaultConversationRunSettings } from '/features/enterprise/run-settings.ts';
        import { FeedbackProvider } from '/components/feedback/FeedbackProvider.tsx';
        function Fixture() {
          const [settings, setSettings] = React.useState({ ...defaultConversationRunSettings(), modelId: 'test-model' });
          const props = { busy: false, employees: [], settings, models: ['test-model'], onSettingsChange: patch => setSettings(current => ({ ...current, ...patch })), onChooseFolder: async () => null, onStart: () => { window.promptSubmissions++; } };
          const content = ${mode === 'chat' ? "React.createElement(ChatArrange, { ...props, employeeId: '', onEmployeeChange: () => {} })" : mode === 'auto' ? 'React.createElement(AutoArrange, props)' : 'React.createElement(ManualArrange, { ...props, seed: null, onSave: () => true })'};
          return React.createElement(FeedbackProvider, null, React.createElement('main', { className: 'ent-shell ent-scroll-arrange', style: { height: '100vh', padding: 24 } }, React.createElement('div', { className: 'ent-arr ent-arr-mode-${mode}', style: { padding: 0 } }, React.createElement('div', { className: 'ent-arr-view' }, content))));
        }
        ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Fixture));` }))
      await page.goto(base)
      const examples = page.getByRole('group', { name: '电商提示词示例' })
      await examples.waitFor()
      const geometry = await examples.evaluate(element => {
        const parent = element.parentElement
        const title = element.previousElementSibling.getBoundingClientRect()
        const group = element.getBoundingClientRect()
        const heading = parent.getBoundingClientRect()
        const input = window.document.querySelector('.ent-chat-ask, .ent-goal, .ent-mn-composer').getBoundingClientRect()
        const buttons = [...element.querySelectorAll('button')].map(button => button.getBoundingClientRect())
        const rowLeft = Math.min(...buttons.map(button => button.left)), rowRight = Math.max(...buttons.map(button => button.right))
        return { parent: parent.className, below: group.top - title.bottom, centered: Math.abs((rowLeft + rowRight) / 2 - (heading.left + heading.right) / 2), aboveInput: group.bottom <= input.top, inside: group.left >= 0 && group.right <= window.innerWidth, overflow: window.document.documentElement.scrollWidth > window.innerWidth }
      })
      assert.match(geometry.parent, /ent-(arr|mn)-empty-state/)
      assert.ok(geometry.below >= 18 && geometry.below <= 24, JSON.stringify(geometry))
      assert.ok(geometry.centered <= 2, JSON.stringify(geometry))
      assert.equal(geometry.aboveInput, true, JSON.stringify(geometry))
      assert.equal(geometry.inside, true)
      assert.equal(geometry.overflow, false)
      await page.screenshot({ path: `output/playwright/prompt-examples-${mode}-${width}.png` })
      await examples.getByRole('button').first().click()
      const input = page.getByRole('textbox', { name: '工作目标', exact: true })
      assert.ok((await input.inputValue()).length > 20)
      await page.waitForFunction(() => window.document.activeElement?.getAttribute('aria-label') === '工作目标')
      assert.equal(await examples.count(), 0)
      assert.equal(await page.evaluate(() => window.promptSubmissions), 0)
      await input.fill('')
      await examples.waitFor()
      assert.deepEqual(errors, [])
    })
  }
}
