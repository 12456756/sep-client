import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { attachConnectorTools } from './pi-connector-tools'
import type { McpRuntime } from './pi-mcp-client'
import type { ConnectorBinding } from '../../domain/connectors'
import { ConnectorInputError } from '../../domain/connectors'
import { evaluateToolCall } from '../../../pi-extension/guard'

test('full DingTalk tools use registered approvals and preserve MCP tools and disposal', async () => {
  let disposed = false
  const base: McpRuntime = { tools: [], permissions: new Map(), dispose: async () => { disposed = true } }
  const binding: ConnectorBinding = { revision: '1', servers: [], fetch, commands: [{ id: 'dingtalk', name: '钉钉', instructions: { reference: 'reference', schema: 'schema', execute: 'execute' },
    reference: async () => 'official guide', schema: async () => ({ text: '{}', isError: false }),
    execute: async () => ({ text: 'uncertain', isError: true, executionUncertain: true }),
  }] }
  assert.equal(attachConnectorTools(base, undefined, '.'), base)
  const runtime = attachConnectorTools(base, binding, '.')
  assert.equal(runtime.tools.length, 3)
  const both = attachConnectorTools(base, { ...binding, commands: [...binding.commands!, { ...binding.commands![0], id: 'feishu', name: '飞书' }] }, '.')
  assert.deepEqual(both.tools.map(tool => tool.name), ['dingtalk_reference', 'dingtalk_schema', 'dingtalk_execute', 'feishu_reference', 'feishu_schema', 'feishu_execute'])
  assert.equal(both.permissions.get('feishu_execute'), 'confirm-each')
  const policy = { allowedTools: [...runtime.permissions.keys()], allowedPaths: [], deniedPaths: [], commandPolicy: 'disabled' as const, approvalMode: 'confirm-each' as const, workspaceDir: '.' }
  assert.equal(evaluateToolCall('dingtalk_execute', {}, policy, runtime.permissions).requiresApproval, true)
  assert.equal(evaluateToolCall('dingtalk_schema', {}, policy, runtime.permissions).requiresApproval, false)
  const result = await runtime.tools[2].execute('id', { args: ['chat', 'send'] }, undefined)
  assert.equal(result.details.executionUncertain, true)
  binding.commands![0].execute = async () => { throw new ConnectorInputError('请查询 dingtalk_schema。') }
  const invalid = await runtime.tools[2].execute('invalid', { args: ['auth', 'export'] }, undefined)
  assert.equal(invalid.details.isError, true)
  assert.match(JSON.stringify(invalid.content), /调用未执行.*dingtalk_schema/)
  binding.commands![0].execute = async () => { throw new Error('secret-credential-must-not-leak') }
  const failure = await runtime.tools[2].execute('failure', { args: ['contact', 'list'] }, undefined)
  assert.doesNotMatch(JSON.stringify(failure), /secret-credential/)
  await runtime.dispose()
  assert.equal(disposed, true)
})
