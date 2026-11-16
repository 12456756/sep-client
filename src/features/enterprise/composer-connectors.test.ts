import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withComposerConnector } from './composer-connectors'

test('all composers preserve ordinary prompts and identify the selected connector', () => {
  assert.equal(withComposerConnector('  查询本周日程  '), '查询本周日程')
  assert.equal(withComposerConnector('查询本周日程', 'dingtalk'), '请使用钉钉连接器完成以下需求：\n\n查询本周日程')
  assert.equal(withComposerConnector('查询本周日程', 'feishu'), '请使用飞书连接器完成以下需求：\n\n查询本周日程')
  assert.equal(withComposerConnector('查询明天的会议', 'tmeet'), '请使用腾讯会议连接器完成以下需求：\n\n查询明天的会议')
  assert.equal(withComposerConnector('读取未读邮件', 'qqmail'), '请使用QQ 邮箱连接器完成以下需求：\n\n读取未读邮件')
})
