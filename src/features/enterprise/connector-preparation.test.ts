import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connectorStateSchema } from '../../shared/connectors'
import { connectorPreparationText } from './connector-preparation'

test('connector preparation reports actual bytes and separates verification from authorization', () => {
  assert.equal(connectorPreparationText({ id: 'dingtalk', status: 'connected' }), undefined)
  assert.equal(connectorPreparationText({ id: 'dingtalk', status: 'preparing' }), '正在准备连接器')
  const state = connectorStateSchema.parse({ id: 'dingtalk', status: 'preparing', dependency: { phase: 'downloading', received: 1048576, total: 2097152 } })
  assert.equal(connectorPreparationText(state), '正在下载组件 50%（1.0 / 2.0 MB）')
  assert.equal(connectorPreparationText({ ...state, dependency: { ...state.dependency!, phase: 'verifying' } }), '正在校验连接器组件')
})
