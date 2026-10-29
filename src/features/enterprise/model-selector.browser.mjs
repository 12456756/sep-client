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

async function openPage(t, { models = ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra'], modelId = 'gpt-5.6-luna', conversation = true, dark = false, width = 1100 } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 850 } })
  t.after(() => page.close())
  await page.route(/\/main\.tsx(?:\?.*)?$/, route => route.fulfill({ contentType: 'text/javascript', body: `${entry}
    import '/index.css';
    import '/styles/enterprise.css';
    import '/styles/arrange.css';
    import { RunSettingsBar } from '/components/enterprise/arrange/RunSettingsDrawer.tsx';
    function Fixture() {
      const [settings, setSettings] = React.useState({ modelId: ${JSON.stringify(modelId)} });
      return React.createElement('main', { className: ${JSON.stringify(dark ? 'ent-shell dark' : '')}, style: { position: 'absolute', left: 32, right: 32, bottom: 32, height: 80, display: 'flex', alignItems: 'flex-end', transform: 'translateZ(0)', overflow: 'hidden' } },
        React.createElement(RunSettingsBar, { settings, models: ${JSON.stringify(models)}, conversation: ${conversation}, onChange: patch => setSettings(current => ({ ...current, ...patch })) }),
        React.createElement('output', { id: 'selected-model' }, settings.modelId));
    }
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Fixture));` }))
  await page.goto(base)
  return page
}

test('model selection opens a searchable popover above the trigger with the knowledge picker style', async t => {
  const page = await openPage(t)
  const trigger = page.getByRole('combobox', { name: '模型', exact: true })
  assert.equal(await trigger.evaluate(element => element.tagName), 'BUTTON')
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: '选择模型' })
  await dialog.waitFor()
  const button = await trigger.boundingBox(), popup = await dialog.boundingBox()
  assert.ok(Math.abs(popup.y + popup.height - (button.y - 8)) <= 2)
  assert.ok(Math.abs(popup.x - button.x) <= 2)
  assert.deepEqual(await dialog.evaluate(element => {
    const style = window.getComputedStyle(element)
    return [style.position, style.borderRadius, style.backgroundColor]
  }), ['fixed', '10px', 'rgb(255, 255, 255)'])
  assert.equal(await page.getByRole('option', { name: 'gpt-5.6-luna', exact: true }).getAttribute('aria-selected'), 'true')
  await page.getByRole('textbox', { name: '搜索模型', exact: true }).fill('SOL')
  assert.equal(await page.getByRole('option').count(), 1)
  await page.getByRole('option', { name: 'gpt-5.6-sol', exact: true }).click()
  assert.equal(await page.locator('#selected-model').textContent(), 'gpt-5.6-sol')
  assert.equal(await dialog.count(), 0)
  assert.equal(await trigger.textContent(), 'gpt-5.6-sol')
  await trigger.click()
  assert.equal(await page.getByRole('textbox', { name: '搜索模型', exact: true }).inputValue(), '')
  mkdirSync('output/playwright', { recursive: true })
  await page.screenshot({ path: 'output/playwright/model-selector.png' })
})

test('model search has an empty state and supports keyboard selection and dismissal', async t => {
  const page = await openPage(t)
  const trigger = page.getByRole('combobox', { name: '模型', exact: true })
  await trigger.focus()
  await page.keyboard.press('Enter')
  const search = page.getByRole('textbox', { name: '搜索模型', exact: true })
  await search.fill('missing-model')
  assert.equal(await page.getByText('没有匹配的模型', { exact: true }).count(), 1)
  await search.fill('')
  await search.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  assert.equal(await page.locator('#selected-model').textContent(), 'gpt-5.6-sol')
  await trigger.click()
  await page.keyboard.press('Escape')
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false')
  assert.equal(await trigger.evaluate(element => element === window.document.activeElement), true)
  await trigger.click()
  await page.mouse.click(800, 80)
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false')
})

test('a long model list fits a narrow window and keeps the dark theme', async t => {
  const page = await openPage(t, { models: Array.from({ length: 40 }, (_, index) => `model-${index}`), modelId: 'model-0', dark: true, width: 390 })
  await page.getByRole('combobox', { name: '模型', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '选择模型' })
  const popup = await dialog.boundingBox()
  assert.ok(popup.x >= 16 && popup.x + popup.width <= 374 && popup.y >= 16)
  assert.equal(await dialog.evaluate(element => window.getComputedStyle(element).backgroundColor), 'rgb(26, 29, 38)')
  await page.getByRole('option', { name: 'model-39', exact: true }).click()
  assert.equal(await page.locator('#selected-model').textContent(), 'model-39')
})

test('empty and unavailable model catalogs preserve the existing selection rules', async t => {
  const empty = await openPage(t, { models: [], modelId: '' })
  assert.equal(await empty.getByRole('combobox', { name: '模型', exact: true }).isDisabled(), true)
  const conversation = await openPage(t, { models: ['available'], modelId: 'revoked' })
  await conversation.getByRole('combobox', { name: '模型', exact: true }).click()
  assert.equal(await conversation.getByRole('option', { name: 'available', exact: true }).getAttribute('aria-selected'), 'true')
  assert.equal(await conversation.locator('#selected-model').textContent(), 'revoked')
  const arrangement = await openPage(t, { models: ['available'], modelId: '', conversation: false })
  const trigger = arrangement.getByRole('combobox', { name: '模型', exact: true })
  assert.equal(await trigger.textContent(), '模型')
  await trigger.click()
  await arrangement.getByRole('option', { name: 'available', exact: true }).click()
  await trigger.click()
  await arrangement.getByRole('option', { name: '暂不选择', exact: true }).click()
  assert.equal(await arrangement.locator('#selected-model').textContent(), '')
})
