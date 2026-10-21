import { after, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluateToolCall, type ToolPolicy } from './guard'

const policy: ToolPolicy = {
  allowedTools: ['read', 'grep', 'find', 'ls', 'write', 'edit', 'bash'],
  allowedPaths: [],
  deniedPaths: [],
  commandPolicy: 'confirm-each',
  approvalMode: 'auto-approve',
  workspaceDir: 'C:/workspace',
}

const unrestrictedPolicy: ToolPolicy = {
  ...policy,
  preset: 'full-local',
  allowedTools: ['read'],
  allowedPaths: ['src'],
  deniedPaths: ['src/private'],
  commandPolicy: 'disabled',
}

describe('delivery snapshot read permissions', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sep-delivery-guard-')))
  const workspace = join(root, 'workspace')
  const snapshot = join(root, 'private', 'result.xlsx')
  const adjacent = join(root, 'private', 'other.xlsx')
  mkdirSync(workspace)
  mkdirSync(join(root, 'private'))
  writeFileSync(snapshot, 'snapshot')
  writeFileSync(adjacent, 'other')
  const snapshotPolicy = { ...policy, workspaceDir: workspace, readableDeliveryPaths: [snapshot] }
  after(() => rmSync(root, { recursive: true, force: true }))

  it('grants only reads of the exact host-approved file', () => {
    assert.equal(evaluateToolCall('read', { path: snapshot }, snapshotPolicy).allowed, true)
    for (const tool of ['write', 'edit', 'ls', 'grep', 'find']) {
      assert.equal(evaluateToolCall(tool, { path: snapshot }, snapshotPolicy).allowed, false)
    }
    assert.equal(evaluateToolCall('read', { path: adjacent }, snapshotPolicy).allowed, false)
    assert.equal(evaluateToolCall('ls', { path: join(root, 'private') }, snapshotPolicy).allowed, false)
    assert.equal(evaluateToolCall('read', { path: snapshot }, { ...snapshotPolicy, allowedTools: [] }).allowed, false)
  })

  it('respects denied paths even for an approved snapshot', () => {
    for (const denied of [snapshot, join(root, 'private')]) {
      assert.equal(evaluateToolCall('read', { path: snapshot }, { ...snapshotPolicy, deniedPaths: [denied] }).allowed, false)
    }
  })

  it('revokes an approved path if it is replaced by a directory link', () => {
    const original = join(root, 'original')
    const replacement = join(root, 'replacement')
    mkdirSync(original)
    mkdirSync(replacement)
    const approved = join(original, 'result.xlsx')
    writeFileSync(approved, 'approved')
    writeFileSync(join(replacement, 'result.xlsx'), 'replacement')
    rmSync(approved)
    rmdirSync(original)
    symlinkSync(replacement, original, process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(evaluateToolCall('read', { path: approved }, { ...snapshotPolicy, readableDeliveryPaths: [approved] }).allowed, false)
  })
})

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


describe('full-local auto-approve mode', () => {
  it('runs every available built-in or registered MCP tool without policy bounds or approval', () => {
    assert.deepEqual(evaluateToolCall('write', { path: 'C:/outside/report.md' }, unrestrictedPolicy), {
      allowed: true, requiresApproval: false,
    })
    assert.deepEqual(evaluateToolCall('bash', { command: 'rm -rf C:/outside' }, unrestrictedPolicy), {
      allowed: true, requiresApproval: false,
    })
    assert.deepEqual(evaluateToolCall('mcp__docs__search', {}, unrestrictedPolicy, new Map([["mcp__docs__search", 'confirm-each']])), {
      allowed: true, requiresApproval: false,
    })
  })

  it('does not invent an executor for an unknown tool', () => {
    assert.deepEqual(evaluateToolCall('not-registered', {}, unrestrictedPolicy), {
      allowed: false, requiresApproval: false, reason: 'unknown-tool',
    })
  })
})
