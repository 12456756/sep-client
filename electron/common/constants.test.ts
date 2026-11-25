import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { hasSideEffects } from './constants'
import { evaluateToolCall, requiresToolApproval } from '../../pi-extension/guard'

describe('MCP side-effect recovery classification', () => {
  it('conservatively tracks external tools for interrupted runs', () => {
    assert.equal(hasSideEffects('mcp__browser__click'), true)
    assert.equal(hasSideEffects('mcp__search__query'), true)
    assert.equal(hasSideEffects('dingtalk_execute'), true)
    assert.equal(hasSideEffects('feishu_schema'), false)
    assert.equal(hasSideEffects('ls'), false)
  })
  it('does not mistake recovery classification for execution permission', () => {
    for (const name of ['mcp__unregistered__tool', 'dingtalk_execute']) {
      assert.equal(requiresToolApproval(name), false)
      assert.deepEqual(evaluateToolCall(name, { path: '.' }, {
        allowedTools: [name], allowedPaths: [], deniedPaths: [], commandPolicy: 'disabled',
        approvalMode: 'auto-approve', workspaceDir: process.cwd(),
      }), { allowed: false, requiresApproval: false, reason: 'unknown-tool' })
    }
  })
})
