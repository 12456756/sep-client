import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { evaluateToolCall, type ToolPolicy } from './guard'

const policy: ToolPolicy = {
  allowedTools: ['read', 'write', 'edit', 'bash'],
  allowedPaths: [],
  deniedPaths: [],
  commandPolicy: 'confirm-each',
  approvalMode: 'auto-approve',
  workspaceDir: 'C:/workspace',
}

describe('tool guard task policy', () => {
  it('auto-approves allowed high-risk tools only after path and command checks', () => {
    assert.deepEqual(evaluateToolCall('write', { path: 'C:/workspace/report.md' }, policy), { allowed: true, requiresApproval: false })
    assert.equal(evaluateToolCall('write', { path: 'C:/secrets.txt' }, policy).allowed, false)
    assert.equal(evaluateToolCall('bash', { command: 'rm -rf C:/workspace' }, policy).allowed, false)
  })

  it('keeps unknown and disallowed tools denied even in auto-approve mode', () => {
    assert.equal(evaluateToolCall('unknown', {}, policy).allowed, false)
    assert.equal(evaluateToolCall('bash', { command: 'echo ok' }, { ...policy, allowedTools: ['read'], commandPolicy: 'disabled' }).allowed, false)
  })
})
