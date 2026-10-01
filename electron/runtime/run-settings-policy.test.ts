import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { effectivePermissionPolicy, type PermissionPreset } from '../domain/arrangement-plan'
import { evaluateToolCall, type ToolPolicy } from '../../pi-extension/guard'

describe('task execution permission settings', () => {
  for (const preset of ['read-only', 'workspace-edit', 'full-local'] satisfies PermissionPreset[]) {
    for (const approvalMode of ['confirm-each', 'auto-approve'] as const) {
      it(`${preset}/${approvalMode} applies the preset unless unrestricted`, () => {
        const permissions = effectivePermissionPolicy({ preset, approvalMode })
        const policy: ToolPolicy = { ...permissions, approvalMode, workspaceDir: 'D:/workspace' }
        assert.equal(evaluateToolCall('read', { path: 'report.md' }, policy).allowed, true)
        const write = evaluateToolCall('write', { path: 'report.md' }, policy)
        const unrestricted = preset === 'full-local' && approvalMode === 'auto-approve'
        assert.equal(write.allowed, unrestricted || preset !== 'read-only')
        assert.equal(write.requiresApproval, !unrestricted && preset !== 'read-only' && approvalMode === 'confirm-each')
        assert.equal(evaluateToolCall('bash', { command: 'echo hello' }, policy).allowed, unrestricted || preset === 'full-local')
        assert.equal(evaluateToolCall('unknown-tool', {}, policy).allowed, false)
        assert.equal(evaluateToolCall('write', { path: '../outside.md' }, policy).allowed, unrestricted)
        assert.equal(evaluateToolCall('bash', { command: 'rm -rf /' }, policy).allowed, unrestricted)
      })
    }
  }
})
