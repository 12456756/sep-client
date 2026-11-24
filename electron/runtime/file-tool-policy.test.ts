import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import { effectivePermissionPolicy } from '../domain/arrangement-plan'
import { runtimeFileToolPolicy } from './file-tool-policy'

test('legacy unrestricted tasks get workspace access unless an interactive run explicitly grants local file access', () => {
  const previous = effectivePermissionPolicy({ preset: 'full-local', approvalMode: 'auto-approve' })
  assert.equal(runtimeFileToolPolicy(previous, '/work').fileAccess, 'workspace')
  assert.equal(runtimeFileToolPolicy(previous, '/work', { fullFileAccess: true, unattended: true }).fileAccess, 'workspace')
  const current = runtimeFileToolPolicy(previous, '/work', { fullFileAccess: true })
  assert.equal(current.fileAccess, 'local')
  assert.equal(current.commandPolicy, 'disabled')
  assert.equal(current.approvalMode, 'confirm-each')
  assert.ok(!current.allowedTools.includes('bash'))
})
