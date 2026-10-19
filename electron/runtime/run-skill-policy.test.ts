import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { evaluateToolCall, type ToolPolicy } from '../../pi-extension/guard'
import type { SkillArtifactAvailable } from '../common/platform/skill-artifact-contract'
import { effectivePermissionPolicy } from '../domain/arrangement-plan'
import type { EmployeeRuntimeConfig } from './run-types'
import { withApprovedSkillReadPaths } from './run-skill-policy'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture(format: 'single-file' | 'zip' = 'single-file') {
  const profile = await mkdtemp(join(tmpdir(), 'sep-approved-skill-policy-'))
  directories.push(profile)
  const workspaceDir = join(profile, 'task-workspaces', 'task')
  // Provisioner installs a package, then exposes the entry's directory to authorizer/Pi.
  const packageRoot = join(profile, 'runtime', 'enterprise', 'member', 'sub-a', 'skills', 'cap-a', 'version-hash', '直播脚本编排')
  const artifactEntryPath = format === 'zip' ? '直播脚本编排/SKILL.md' : 'SKILL.md'
  const entryPath = join(packageRoot, artifactEntryPath)
  const resourcePath = join(dirname(entryPath), 'references', '流程.md')
  const otherEntry = join(profile, 'runtime', 'sub-b', 'skills', 'cap-b', 'SKILL.md')
  const outside = join(profile, 'private.txt')
  for (const path of [workspaceDir, dirname(resourcePath), dirname(otherEntry)]) await mkdir(path, { recursive: true })
  const content = '---\nname: 直播脚本编排\ndescription: 流程策划\n---\n直播脚本'
  const sha256 = createHash('sha256').update(content).digest('hex')
  await Promise.all([
    writeFile(entryPath, content), writeFile(resourcePath, '批准包资源'), writeFile(otherEntry, '其他订阅技能'),
    writeFile(outside, '私有文件'), writeFile(join(workspaceDir, 'report.md'), '任务资料'),
  ])
  const artifact: SkillArtifactAvailable = {
    protocolVersion: 1, status: 'AVAILABLE', capabilityId: 'cap-a', versionId: 'v1',
    approvedContentSha256: sha256, format, installationDirectory: '直播脚本编排',
    entryPath: artifactEntryPath,
    entrySha256: sha256, artifactSha256: sha256, byteLength: Buffer.byteLength(content),
    fileCount: format === 'zip' ? 2 : 1,
    downloadPath: '/client/subscriptions/sub-a/skills/cap-a/versions/v1/artifact',
  }
  const employee: EmployeeRuntimeConfig = {
    subscriptionId: 'sub-a', modelId: 'model', gatewayUrl: 'http://gateway.invalid', additionalSkillPaths: [dirname(entryPath)],
    runtimeSnapshot: {
      manifestVersion: 1, skillArtifactProtocolVersion: 1, subscriptionId: 'sub-a', enterpriseId: 'enterprise',
      employeeId: 'employee', templateVersion: '1', employeeVersion: '1', maxSteps: 10,
      systemPrompt: '', modelId: 'model', allowedModels: ['model'],
      approvedSkills: [{ capabilityId: 'cap-a', name: '直播脚本编排', description: '流程策划', versionId: 'v1', version: '1', content, artifact }],
      skills: [{ capabilityId: 'cap-a', versionId: 'platform-v1', baseSkillVersionId: 'v1', version: '1',
        source: 'approved', name: '直播脚本编排', description: '流程策划', content, sha256, path: dirname(entryPath), artifact }],
    },
  }
  const policy: ToolPolicy = { ...effectivePermissionPolicy({ preset: 'read-only', approvalMode: 'auto-approve' }), approvalMode: 'auto-approve', workspaceDir }
  return { employee, policy, profile, packageRoot, entryPath, resourcePath, otherEntry, outside }
}

function granted(employee: EmployeeRuntimeConfig, policy: ToolPolicy): ToolPolicy {
  const result = withApprovedSkillReadPaths(policy, employee)
  assert.ok(result)
  return result
}

describe('run-approved skill read permissions', () => {
  it('resolves SKILL.md from the installed descriptor directory under default read-only policy', async () => {
    const f = await fixture()
    assert.equal(f.employee.runtimeSnapshot!.skills[0]!.path, dirname(f.entryPath))
    assert.deepEqual(f.employee.additionalSkillPaths, [dirname(f.entryPath)])
    assert.equal(evaluateToolCall('read', { path: f.entryPath }, f.policy).reason, 'path-not-allowed')
    const policy = granted(f.employee, f.policy)
    assert.deepEqual(evaluateToolCall('read', { path: f.entryPath }, policy), { allowed: true, requiresApproval: false })
    assert.equal(evaluateToolCall('read', { path: relative(f.policy.workspaceDir, f.entryPath) }, policy).allowed, true)
    assert.equal(evaluateToolCall('read', { path: 'report.md' }, policy).allowed, true)
    assert.equal(evaluateToolCall('read', { path: f.resourcePath }, policy).allowed, false)
  })

  it('allows zip resources while denying parent, sibling, another subscription and unrelated files', async () => {
    const f = await fixture('zip')
    const policy = granted(f.employee, f.policy)
    assert.equal(evaluateToolCall('read', { path: f.resourcePath }, policy).allowed, true)
    for (const path of [f.packageRoot, dirname(f.packageRoot), f.otherEntry, f.outside, join(f.packageRoot, '..', 'v2', 'SKILL.md')]) {
      assert.equal(evaluateToolCall('read', { path }, policy).allowed, false, path)
    }
  })

  it('does not expand write/edit/bash or recursive tool access and preserves workspace-edit behavior', async () => {
    const f = await fixture('zip')
    const base: ToolPolicy = { ...f.policy, preset: 'workspace-edit', allowedTools: ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'], commandPolicy: 'confirm-each' }
    const policy = granted(f.employee, base)
    for (const tool of ['write', 'edit', 'grep', 'find', 'ls']) {
      assert.equal(evaluateToolCall(tool, { path: f.entryPath }, policy).allowed, false, tool)
    }
    assert.equal(evaluateToolCall('bash', { command: `cat ${f.entryPath}` }, policy).allowed, false)
    assert.equal(evaluateToolCall('write', { path: 'report.md' }, policy).allowed, true)
    assert.equal(evaluateToolCall('write', { path: 'report.md' }, granted(f.employee, f.policy)).allowed, false)
    assert.equal(evaluateToolCall('unknown', { path: f.entryPath }, policy).allowed, false)
    assert.equal(evaluateToolCall('read', { path: f.entryPath }, { ...policy, allowedTools: [] }).allowed, false)
  })

  it('keeps explicit denials above approved skill grants, including symlink aliases', async () => {
    const f = await fixture('zip')
    const alias = join(f.profile, 'denied-alias')
    await symlink(dirname(f.resourcePath), alias, 'dir')
    for (const denied of [f.entryPath, f.packageRoot]) {
      assert.equal(evaluateToolCall('read', { path: f.entryPath }, granted(f.employee, { ...f.policy, deniedPaths: [denied] })).allowed, false)
    }
    assert.equal(evaluateToolCall('read', { path: f.resourcePath }, granted(f.employee, { ...f.policy, deniedPaths: [alias] })).allowed, false)
  })

  it('rejects symlinks escaping a zip package but permits a link to an in-package resource', async () => {
    const f = await fixture('zip')
    const escape = join(dirname(f.entryPath), 'escape.md')
    const inside = join(dirname(f.entryPath), 'inside.md')
    await symlink(f.outside, escape)
    await symlink(f.resourcePath, inside)
    const policy = granted(f.employee, f.policy)
    assert.equal(evaluateToolCall('read', { path: escape }, policy).allowed, false)
    assert.equal(evaluateToolCall('read', { path: inside }, policy).allowed, true)
  })

  it('fails closed if a granted package root is replaced by a symlink', async () => {
    const f = await fixture('zip')
    const policy = granted(f.employee, f.policy)
    await rm(f.packageRoot, { recursive: true })
    await symlink(dirname(f.otherEntry), f.packageRoot, 'dir')
    assert.equal(evaluateToolCall('read', { path: join(f.packageRoot, 'SKILL.md') }, policy).allowed, false)
  })

  it('rejects an entry replaced with an external symlink after grant creation', async () => {
    const f = await fixture()
    const policy = granted(f.employee, f.policy)
    await rm(f.entryPath)
    await symlink(f.outside, f.entryPath)
    assert.equal(evaluateToolCall('read', { path: f.entryPath }, policy).allowed, false)
  })

  it('does not grant arbitrary loader paths, owner-local versions, stale versions or wrong subscriptions', async () => {
    const f = await fixture()
    const snapshot = f.employee.runtimeSnapshot!
    const skill = snapshot.skills[0]!
    const invalid: EmployeeRuntimeConfig[] = [
      { ...f.employee, runtimeSnapshot: undefined },
      { ...f.employee, additionalSkillPaths: [dirname(f.otherEntry)] },
      { ...f.employee, subscriptionId: 'sub-b' },
      { ...f.employee, runtimeSnapshot: { ...snapshot, skills: [{ ...skill, source: 'owner-local' }] } },
      { ...f.employee, runtimeSnapshot: { ...snapshot, skills: [{ ...skill, baseSkillVersionId: 'v0' }] } },
      { ...f.employee, runtimeSnapshot: { ...snapshot, approvedSkills: [] } },
      { ...f.employee, runtimeSnapshot: { ...snapshot, skills: [{ ...skill, artifact: undefined }] } },
    ]
    for (const employee of invalid) assert.equal(granted(employee, f.policy).approvedSkillPaths?.length, 0)
  })

  it('rejects changed or missing installed bytes', async () => {
    const f = await fixture()
    await writeFile(f.entryPath, '替换技能')
    assert.equal(granted(f.employee, f.policy).approvedSkillPaths?.length, 0)
    await rm(f.entryPath)
    assert.equal(granted(f.employee, f.policy).approvedSkillPaths?.length, 0)
  })

  it('rejects entry-directory symlinks and malformed zip entry paths before granting access', async () => {
    const f = await fixture('zip')
    const snapshot = f.employee.runtimeSnapshot!
    const skill = snapshot.skills[0]!
    const alias = join(f.profile, 'skill-alias')
    await symlink(skill.path, alias, 'dir')
    const linked = { ...f.employee, additionalSkillPaths: [alias],
      runtimeSnapshot: { ...snapshot, skills: [{ ...skill, path: alias }] } }
    assert.equal(granted(linked, f.policy).approvedSkillPaths?.length, 0)
    for (const entryPath of ['../SKILL.md', '/SKILL.md', '直播脚本编排/../SKILL.md', 'wrong/SKILL.md']) {
      const artifact = { ...skill.artifact!, entryPath }
      const invalid = { ...f.employee, runtimeSnapshot: { ...snapshot,
        skills: [{ ...skill, artifact }], approvedSkills: [{ ...snapshot.approvedSkills[0]!, artifact }] } }
      assert.equal(granted(invalid, f.policy).approvedSkillPaths?.length, 0, entryPath)
    }
  })

  it('freezes grants independently of subsequent loader-path changes', async () => {
    const f = await fixture()
    const policy = granted(f.employee, f.policy)
    assert.equal(policy.approvedSkillPaths?.[0]?.entryPath, await realpath(f.entryPath))
    assert.equal(Object.isFrozen(policy.approvedSkillPaths), true)
    assert.equal(Object.isFrozen(policy.approvedSkillPaths?.[0]), true)
    f.employee.additionalSkillPaths!.push(dirname(f.otherEntry))
    assert.equal(evaluateToolCall('read', { path: f.otherEntry }, policy).allowed, false)
    assert.equal(withApprovedSkillReadPaths(undefined, f.employee), undefined)
  })
})
