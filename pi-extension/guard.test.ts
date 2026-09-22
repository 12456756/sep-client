import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { evaluateToolCall, type ToolPolicy } from './guard'

const policy: ToolPolicy = {
  allowedTools: ['read', 'grep', 'find', 'ls', 'write', 'edit', 'bash'],
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

  it('uses the workspace as the default path for read-only search tools', () => {
    assert.equal(evaluateToolCall('ls', {}, policy).allowed, true)
    assert.equal(evaluateToolCall('grep', { pattern: 'TODO' }, policy).allowed, true)
    assert.equal(evaluateToolCall('find', { pattern: '*.ts' }, policy).allowed, true)
  })

  it('keeps read path-required and explicit paths protected', () => {
    assert.deepEqual(evaluateToolCall('read', {}, policy), {
      allowed: false,
      requiresApproval: false,
      reason: 'path-required',
    })
    assert.equal(evaluateToolCall('ls', { path: '../outside' }, policy).allowed, false)
    assert.equal(evaluateToolCall('ls', {}, { ...policy, allowedPaths: ['src'] }).allowed, false)
  })

  it('rejects the removed web search instead of granting unrestricted access', () => {
    assert.deepEqual(evaluateToolCall('web_search', { query: 'SEP' }, { ...policy, allowedTools: ['web_search'] }), {
      allowed: false,
      requiresApproval: false,
      reason: 'unknown-tool',
    })
  })

  it('keeps unknown and disallowed tools denied even in auto-approve mode', () => {
    assert.equal(evaluateToolCall('unknown', {}, policy).allowed, false)
    assert.equal(evaluateToolCall('bash', { command: 'echo ok' }, { ...policy, allowedTools: ['read'], commandPolicy: 'disabled' }).allowed, false)
  })
})


describe('registered MCP tool permissions', () => {
  const name = 'mcp__docs__search'
  const registered = new Map([[name, 'confirm-each' as const]])
  it('requires approval even when built-in tools are auto-approved', () => {
    assert.deepEqual(evaluateToolCall(name, {}, { ...policy, allowedTools: [name] }, registered), {
      allowed: true, requiresApproval: true,
    })
  })
  it('does not grant permissions from a prefix or read-only annotations', () => {
    assert.equal(evaluateToolCall('mcp__fake__search', {}, { ...policy, allowedTools: ['mcp__fake__search'] }, registered).allowed, false)
    assert.equal(evaluateToolCall(name, {}, policy, registered).allowed, false)
  })
  it('accepts explicit configured auto-approval', () => {
    assert.deepEqual(evaluateToolCall(name, {}, { ...policy, allowedTools: [name] }, new Map([[name, 'auto-approve']])), {
      allowed: true, requiresApproval: false,
    })
  })
})
