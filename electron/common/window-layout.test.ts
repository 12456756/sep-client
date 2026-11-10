import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { getWindowChromeConfig, WINDOW_THEME_COLORS } from './window-layout'

test('macOS reserves a top chrome area and uses inset traffic lights', () => {
  assert.deepEqual(getWindowChromeConfig('darwin'), {
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 14 },
    contentTop: 44,
    windowsRightInset: 0,
  })
})

test('Windows uses title bar overlay and reserves the system controls', () => {
  assert.deepEqual(getWindowChromeConfig('win32'), {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#f8f1ef',
      symbolColor: '#514d55',
      height: 44,
    },
    contentTop: 44,
    windowsRightInset: 144,
  })
})

test('other platforms keep the same content contract without Windows insets', () => {
  assert.deepEqual(getWindowChromeConfig('aix'), {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#f8f1ef',
      symbolColor: '#514d55',
      height: 44,
    },
    contentTop: 44,
    windowsRightInset: 0,
  })
})

test('native title bar themes match the renderer toolbar surfaces and symbols', () => {
  const styles = readFileSync(new URL('../../src/styles/enterprise.css', import.meta.url), 'utf8')
  const light = styles.slice(styles.indexOf(':root {'), styles.indexOf('.ent-shell.dark'))
  const dark = styles.slice(styles.indexOf('.ent-shell.dark'))
  for (const [theme, css] of [['light', light], ['dark', dark]] as const) {
    const colors = WINDOW_THEME_COLORS[theme]
    assert.ok(css.includes(`--work-rail: ${colors.color};`), `${theme} title bar background`)
    assert.ok(css.includes(`--ent-ink-2: ${colors.symbolColor};`), `${theme} title bar symbols`)
  }
})
