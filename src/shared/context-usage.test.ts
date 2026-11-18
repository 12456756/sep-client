import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { contextUsageLabel, contextUsageSchema } from './context-usage'

test('formats current context usage and keeps missing accounting unknown', () => {
  assert.deepEqual(contextUsageLabel({ tokens: 32000, contextWindow: 128000, percent: 25 }), {
    text: '25%', detail: '当前上下文约 32,000 / 128,000 Token（25.0%）',
  })
  assert.equal(contextUsageLabel(null).text, '--')
  assert.equal(contextUsageLabel({ tokens: null, contextWindow: 128000, percent: null }).text, '--')
  for (const value of [NaN, Infinity, -1]) assert.equal(contextUsageSchema.safeParse({ tokens: value, contextWindow: 128000, percent: 25 }).success, false)
})
