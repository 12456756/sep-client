import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { effectivePermissionPolicy, type PermissionPreset } from '../domain/arrangement-plan'
import { evaluateToolCall, type ToolPolicy } from '../../pi-extension/guard'

describe('task execution permission settings', () => {
  it('only treats safely missing scheduled workspace file reads as non-fatal', async t => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'sep-scheduled-read-policy-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const workspaceDir = join(root, 'workspace')
    await mkdir(workspaceDir)
    await writeFile(join(workspaceDir, 'existing.md'), 'existing')
    await symlink(root, join(workspaceDir, 'linked'), 'junction')
    const permissions = effectivePermissionPolicy({ preset: 'workspace-edit', approvalMode: 'confirm-each' })
    const policy: ToolPolicy = { ...permissions, approvalMode: 'confirm-each', workspaceDir,
      fileAccess: 'workspace', unattended: true, deniedPaths: ['private'] }

    assert.deepEqual(evaluateToolCall('read', { path: 'new/reports/absent.md' }, policy), { allowed: true, requiresApproval: false })
    for (const path of ['../absent.md', 'linked/absent.md', '.git/absent.md', 'private/absent.md', 'existing.md/absent.md']) {
      assert.equal(evaluateToolCall('read', { path }, policy).reason, 'path-not-allowed', path)
    }
    assert.equal(evaluateToolCall('read', { path: 'absent.md' }, { ...policy, unattended: false }).reason, 'path-not-allowed')
    assert.equal(evaluateToolCall('ls', { path: 'absent' }, policy).reason, 'path-not-allowed')
  })

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
