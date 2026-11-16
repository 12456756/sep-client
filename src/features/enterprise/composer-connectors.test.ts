import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withComposerConnector } from './composer-connectors'

test('all composers preserve ordinary prompts and identify the selected connector', () => {
  assert.equal(withComposerConnector('  查询本周日程  '), '查询本周日程')
  assert.equal(withComposerConnector('查询本周日程', 'dingtalk'), '请使用钉钉连接器完成以下需求：\n\n查询本周日程')
  assert.equal(withComposerConnector('查询本周日程', 'feishu'), '请使用飞书连接器完成以下需求：\n\n查询本周日程')
})
