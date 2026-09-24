/* global window, document */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import process from 'node:process';
import { log } from 'node:console';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

function findBrowserExecutable() {
  const candidates = [
    process.env.SEP_PREVIEW_BROWSER,
    process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null,
    process.platform === 'darwin' ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' : null,
    process.platform === 'win32' ? `${process.env['PROGRAMFILES'] ?? 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe` : null,
    process.platform === 'win32' ? `${process.env['PROGRAMFILES'] ?? 'C:\\Program Files'}\\Microsoft\\Edge\\Application\\msedge.exe` : null,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  return candidates.find(candidate => existsSync(candidate));
}

const executablePath = findBrowserExecutable();
if (!executablePath) {
  throw new Error('No Chromium browser found. Set SEP_PREVIEW_BROWSER or install Chrome/Edge before running the preview check.');
}
const browser = await chromium.launch({ executablePath, headless: true });
const outputDir = process.env.SEP_PREVIEW_OUTPUT_DIR ?? join(process.cwd(), 'output', 'playwright');
mkdirSync(outputDir, { recursive: true });
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
    const switches = page.locator('.ent-view-switch button');
    await switches.nth(1).click();
    await page.locator('.org-unavailable').waitFor({ state: 'attached' });
    assert.equal(await page.locator('.org-tree-card, .org-demo-badge, .ent-desk').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: join(outputDir, `sep-org-${viewport.width}.png`) });

    await switches.nth(0).focus();
    await page.keyboard.press('Enter');
    await page.locator('.preview-disconnected').waitFor({ state: 'attached' });
    assert.equal(await page.locator('.ent-desk').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: join(outputDir, `sep-home-${viewport.width}.png`) });

    await page.keyboard.press('Control+K');
    await page.locator('[role="dialog"]').waitFor();
    assert.equal(await page.locator('[role="dialog"] input').count(), 1);
    await page.keyboard.press('Escape');
    await page.locator('[role="dialog"]').waitFor({ state: 'detached' });

    await page.getByRole('button', { name: /切换到深色主题/ }).click();
    assert.equal(await page.locator('.ent-shell.dark').count(), 1);
    await page.screenshot({ path: join(outputDir, `sep-home-${viewport.width}-dark.png`) });
    await page.getByRole('button', { name: /切换到浅色主题/ }).click();
  }

  assert.deepEqual(errors, []);
  log('PASS: no fabricated organization, employees or IPC; responsive, command palette and theme states verified');
} finally {
  await browser.close();
}
