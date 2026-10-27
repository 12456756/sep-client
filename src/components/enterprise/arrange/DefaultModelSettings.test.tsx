import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DefaultModelSettings } from '../DefaultModelSettings'
import { ModelPreferenceProvider } from '../../workspace/model-preference-scope'
import { modelPreferenceKey } from '../../../shared/model-preferences'

function render(models: string[], preferred = ''): string {
  const previousReact = Reflect.get(globalThis, 'React'), previousWindow = Reflect.get(globalThis, 'window')
  const scope = { enterpriseId: 'enterprise', memberId: 'member' }
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: {
    getItem: (key: string) => key === modelPreferenceKey(scope) ? JSON.stringify({ version: 1, defaultModelId: preferred }) : null,
  } } })
  try {
    return renderToStaticMarkup(React.createElement(ModelPreferenceProvider, { scope,
      children: React.createElement(DefaultModelSettings, { models }),
    }))
  } finally {
    for (const [key, value] of [['React', previousReact], ['window', previousWindow]] as const) {
      if (value === undefined) Reflect.deleteProperty(globalThis, key)
      else Object.defineProperty(globalThis, key, { configurable: true, value })
    }
  }
}

test('default model settings offer the system default and select the saved model', () => {
  const html = render(['first', 'gpt'], 'gpt')
  assert.match(html, /for="client-default-model"/)
  assert.match(html, /跟随系统默认/)
  assert.match(html, /<option value="gpt" selected="">gpt<\/option>/)
})

test('revoked preferences remain visible and can be replaced instead of silently deleted', () => {
  const html = render(['first'], 'revoked')
  assert.match(html, /<option value="revoked" disabled="" selected="">revoked（当前不可用）<\/option>/)
  assert.match(html, /<option value="first">first<\/option>/)
})

test('an empty catalog retains the system default and safely escapes model names', () => {
  assert.match(render([]), /<option value="" selected="">跟随系统默认<\/option>/)
  const html = render(['<script>test</script>'])
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;script&gt;/)
})
