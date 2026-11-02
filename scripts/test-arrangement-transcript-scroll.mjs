/* global document, getComputedStyle */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { log } from 'node:console'
import process from 'node:process'
import { chromium } from 'playwright-core'

const executablePath = [process.env.SEP_PREVIEW_BROWSER,
  `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['PROGRAMFILES(X86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium',
].filter(Boolean).find(existsSync)
assert.ok(executablePath, 'Install Chrome/Edge or set SEP_PREVIEW_BROWSER')
const css = await readFile(new URL('../src/styles/work-detail.css', import.meta.url), 'utf8')
const output = join(process.cwd(), 'output/arrangement-transcript-scroll')
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ executablePath, headless: true })
try {
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' })
    const lines = Array.from({ length: 60 }, (_, i) => `<p>Message ${i + 1}</p>`).join('')
    await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
      <style>html,body{margin:0;height:100%;font:14px Arial}*{box-sizing:border-box}
      .fixture{display:flex;flex-direction:column;height:100dvh}.spacer{height:320px;flex-shrink:0}
      :root{--ent-line:#ddd;--ent-ink:#222;--ent-ink-2:#555;--ent-ink-3:#777}
      ${css}</style></head><body><main class="fixture"><section class="ent-arrangement-transcript">
      <div class="ent-transcript-toolbar">Task progress</div><div class="ent-transcript-body">
      <div class="ent-transcript-content"><section class="ent-transcript-goal"><strong>You</strong><p>Report</p></section>
      <div class="spacer"></div><section class="ent-transcript-node"><h2>Employee messages</h2>
      <div class="ent-transcript-node-body" tabindex="0"><details class="ent-transcript-thinking" open>
      <summary>Thinking</summary><p>${'Thinking line\n'.repeat(80)}</p></details>${lines}</div></section>
      <div class="spacer"></div></div></div></section></main></body></html>`)
    const inner = page.locator('.ent-transcript-node-body')
    const outer = page.locator('.ent-transcript-body')
    const size = await inner.evaluate(el => ({ height: el.clientHeight, overflow: el.scrollHeight }))
    assert.ok(size.overflow > size.height, 'node must have internally scrollable content')
    const position = async (scrollTop) => {
      await inner.evaluate((el, top) => {
        const parent = el.closest('.ent-transcript-body')
        parent.scrollTop += el.getBoundingClientRect().top - parent.getBoundingClientRect().top - 90
        el.scrollTop = top < 0 ? el.scrollHeight : top
      }, scrollTop)
      const box = await inner.boundingBox()
      await page.mouse.move(box.x + box.width - 30, box.y + 4)
      // Let a new wheel gesture select its scroll target after repositioning.
      await page.waitForTimeout(200)
      return outer.evaluate(el => el.scrollTop)
    }
    const middleOuter = await position(200)
    await page.mouse.wheel(0, -100)
    await page.waitForFunction(() => document.querySelector('.ent-transcript-node-body').scrollTop < 180, undefined, { timeout: 2000 })
    assert.equal(await outer.evaluate(el => el.scrollTop), middleOuter, 'middle scroll must stay inside node')

    const upperOuter = await position(0)
    assert.ok(upperOuter > 100, 'outer must have room to scroll upward')
    await page.mouse.wheel(0, -160)
    await page.waitForFunction(top => document.querySelector('.ent-transcript-body').scrollTop < top - 30, upperOuter, { timeout: 2000 })
    assert.equal(await inner.evaluate(el => el.scrollTop), 0, 'inner must remain at its top')

    const lowerOuter = await position(-1)
    await page.mouse.wheel(0, 160)
    await page.waitForFunction(top => document.querySelector('.ent-transcript-body').scrollTop > top + 30, lowerOuter, { timeout: 2000 })
    assert.ok(await inner.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop < 2), 'inner must remain at its bottom')

    await position(0)
    const thinking = page.locator('.ent-transcript-thinking p')
    await thinking.evaluate(el => { el.scrollTop = 0 })
    const box = await thinking.boundingBox()
    await page.mouse.move(box.x + 20, box.y + 24)
    await page.waitForTimeout(200)
    const thinkingOuter = await outer.evaluate(el => el.scrollTop)
    await page.mouse.wheel(0, -120)
    await page.waitForFunction(top => document.querySelector('.ent-transcript-body').scrollTop < top - 30, thinkingOuter, { timeout: 2000 })
    assert.equal(await inner.evaluate(el => el.clientHeight), size.height, 'scroll chaining must preserve node height')
    assert.equal(await page.evaluate(() => document.documentElement.scrollHeight), height, 'document must stay within viewport')
    assert.equal(await outer.evaluate(el => getComputedStyle(el).overscrollBehaviorY), 'contain', 'outer transcript must remain contained')
    await page.screenshot({ path: join(output, `${width}.png`) })
    log(`PASS ${width}x${height}: internal scrolling, top/bottom chaining, nested thinking and fixed height`)
    await page.close()
  }
} finally { await browser.close() }
