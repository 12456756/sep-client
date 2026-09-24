import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import { getWindowChromeConfig } from './window-layout'

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
      color: '#f7f8fc',
      symbolColor: '#5c6375',
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
      color: '#f7f8fc',
      symbolColor: '#5c6375',
      height: 44,
    },
    contentTop: 44,
    windowsRightInset: 0,
  })
})
