/* global window, document */
import assert from 'node:assert/strict';
import process from 'node:process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log } from 'node:console';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.SEP_PREVIEW_URL ?? 'http://127.0.0.1:5174/?preview=workspace');
  await page.locator('.ent-shell').waitFor();
  assert.equal(await page.evaluate(() => 'electronAPI' in window), false, 'Browser preview must not install fake IPC');
  for (const viewport of [{ width: 1200, height: 800 }, { width: 960, height: 640 }]) {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('.org-unavailable').waitFor();
    assert.equal(await page.locator('.org-tree-card, .org-demo-badge, .ent-desk').count(), 0);
    const switches = page.locator('.ent-view-switch button');
    await switches.nth(0).focus();
    await page.keyboard.press('Enter');
    await page.locator('.preview-disconnected').waitFor();
    assert.equal(await page.locator('.ent-desk').count(), 0);
    await switches.nth(1).click();
    await page.locator('.org-unavailable').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: join(tmpdir(), `sep-no-demo-${viewport.width}.png`) });
  }
  assert.deepEqual(errors, []);
  log('PASS: no fabricated organization, employees or IPC in browser preview; empty states at both viewports');
} finally {
  await browser.close();
}
