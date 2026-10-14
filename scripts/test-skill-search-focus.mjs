/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../', import.meta.url));
const enterpriseCss = await readFile(join(root, 'src/styles/enterprise.css'), 'utf8');
const skillsCss = await readFile(join(root, 'src/styles/skills.css'), 'utf8');
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'msedge', headless: true });

try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    await page.setContent(`<!doctype html><html><head><meta charset="UTF-8">
      <style>${enterpriseCss}\n${skillsCss}</style>
      <style>body{margin:0}.ent-shell{padding:24px;display:block;box-sizing:border-box}.skill-search{box-sizing:border-box;max-width:100%;width:460px}.other-input{margin-top:24px}</style>
      </head><body><div class="ent-shell"><label class="skill-search">
      <span aria-hidden="true">&#9906;</span><input aria-label="Search skills" placeholder="Search skills or employees"></label>
      <input class="other-input" aria-label="Other input"></div></body></html>`);

    const search = page.getByRole('textbox', { name: 'Search skills', exact: true });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => { document.querySelector('.ent-shell').classList.toggle('dark', value === 'dark'); }, theme);
      for (const method of ['keyboard', 'mouse']) {
        if (method === 'keyboard') {
          await page.getByRole('textbox', { name: 'Other input', exact: true }).focus();
          await page.keyboard.press('Shift+Tab');
        }
        else await search.click();
        await search.fill('Alice');
        const style = await search.evaluate(element => {
          const input = getComputedStyle(element);
          const wrapper = getComputedStyle(element.closest('.skill-search'));
          return {
            focused: document.activeElement === element,
            outline: input.outlineStyle,
            shadow: input.boxShadow,
            border: input.borderTopWidth,
            outerOutline: wrapper.outlineStyle,
            outerWidth: wrapper.outlineWidth,
            outerBorder: wrapper.borderTopWidth,
          };
        });
        assert.equal(style.focused, true);
        assert.equal(style.outline, 'none', 'search input must not have an inner focus outline');
        assert.equal(style.shadow, 'none', 'search input must not have an inner focus shadow');
        assert.equal(style.border, '0px');
        assert.equal(style.outerOutline, 'solid', 'outer keyboard focus indicator must remain');
        assert.equal(style.outerWidth, '2px');
        assert.equal(style.outerBorder, '1px');
        assert.equal(await search.inputValue(), 'Alice');
      }
    }
    await page.screenshot({ path: join(tmpdir(), `sep-skill-search-focus-${width}.png`) });
    const other = page.getByRole('textbox', { name: 'Other input', exact: true });
    await other.focus();
    assert.equal(await other.evaluate(element => getComputedStyle(element).outlineStyle), 'solid', 'other inputs must keep their focus outlines');
    await page.close();
    console.log(`PASS skill search focus: ${width}px, mouse/keyboard, light/dark, other inputs unchanged`);
  }
} finally {
  await browser.close();
}
