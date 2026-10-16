/**
 * 员工授权的回归测试。
 *
 * 身份变化必须丢掉平台目录的 TTL 缓存。授权缓存与运行时准入共同依赖这一约束。
 * `GET /client/subscriptions` 加了 15 秒缓存，但只有"认证失效"这一条路径会丢掉它；
 * 登录与登出没丢。缓存不按身份分键，于是"登出后 15 秒内换账号登录"会读到
 * 上一个账号的订阅列表。
 *
 * 这里用**真实的** EmployeeDirectory 加一个计数的 fetcher，断言的是行为
 * （clear() 之后必须重新发请求），不是"invalidate 被调过"。
 */
import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { Subscription } from '../../src/shared/types'
import { EmployeeDirectory } from './employee-directory'
import {
  EmployeeAuthorizer,
  resolveEmployeeRuntime,
  type SkillProvisioner,
  type RuntimeProvider,
} from './employee-authorizer'
import { employeeRuntimeSnapshotSchema, type PreparedEmployeeSkill } from '../common/platform/employee-runtime-contract'
import type { SkillArtifactAvailable } from '../common/platform/skill-artifact-contract'

const GATEWAY = 'http://gateway.test'

function subscription(id: string, modelId = 'sep-employee'): Subscription {
  return {
    id,
    subscriptionId: id,
    employeeId: `template-`, 
    name: `employee-${id}`,
    status: 'ACTIVE',
    templateVersion: '1.0.0',
    template: { id: `template-${id}`, name: `template-${id}`, avatar: null },
    allowedModels: [modelId],
    department: null,
    upgradeAvailable: false,
  }
}

const session = {
  async getValidAccessToken() { return 'access-token' },
  getMeta() { return { enterpriseId: 'enterprise-1' } },
}

/** 记下 prepare / invalidate 被调了几次，并给出固定的技能路径。 */
function fakeSkills(): SkillProvisioner & { prepared: () => number; invalidations: () => number } {
  let prepared = 0
  let invalidations = 0
  return {
    prepared: () => prepared,
    invalidations: () => invalidations,
    async prepare() { prepared += 1; return { skillPaths: ['/skills/a'] } },
    invalidate() { invalidations += 1 },
  }
}

describe('resolveEmployeeRuntime（纯函数）', () => {
  it('maps an active subscription to its first allowed model', () => {
    const result = resolveEmployeeRuntime([subscription('sub-a', 'model-x')], 'sub-a', GATEWAY)
    assert.deepEqual(result, {
      subscriptionId: 'sub-a', modelId: 'model-x', gatewayUrl: GATEWAY,
      employeeProfile: {
        name: 'employee-sub-a', position: undefined, functionalCategory: undefined, description: undefined,
      },
    })
  })

  it('copies only the selected employee identity fields for responsibility judgment', () => {
    const selected = {
      ...subscription('sub-b'), position: 'Frontend Developer',
      functionalCategory: 'Engineering', description: 'Build web interfaces',
    }
    const result = resolveEmployeeRuntime([subscription('sub-a'), selected], 'sub-b', GATEWAY)
    assert.deepEqual(result?.employeeProfile, {
      name: selected.name, position: selected.position,
      functionalCategory: selected.functionalCategory, description: selected.description,
    })
    assert.notEqual(result?.employeeProfile, selected)
  })

  it('returns null for an unknown subscription or one with no allowed model', () => {
    assert.equal(resolveEmployeeRuntime([subscription('sub-a')], 'sub-b', GATEWAY), null)
    const noModel = { ...subscription('sub-a'), allowedModels: [] }
    assert.equal(resolveEmployeeRuntime([noModel], 'sub-a', GATEWAY), null)
  })

  it('never touches anything outside its arguments', () => {
    // 同样的入参两次调用必须得到相等的结果——调度循环依赖这一点（C4）。
    const instances = [subscription('sub-a')]
    assert.deepEqual(
      resolveEmployeeRuntime(instances, 'sub-a', GATEWAY),
      resolveEmployeeRuntime(instances, 'sub-a', GATEWAY),
    )
  })
})

describe('C10 — 身份变化丢弃平台目录缓存', () => {
  it('re-fetches the directory after clear(), even inside the TTL window', async () => {
    let fetches = 0
    let served = [subscription('sub-a')]
    // TTL 保持默认 15s，时钟固定：任何重新请求都只能是 invalidate 的结果，不是 TTL 过期。
    const directory = new EmployeeDirectory(async () => { fetches += 1; return served }, 15_000, () => 1_000)
    const skills = fakeSkills()
    const authorizer = new EmployeeAuthorizer(session, directory, skills, GATEWAY)

    await authorizer.refresh()
    assert.equal(fetches, 1)
    assert.ok(authorizer.resolve('sub-a'), '刷新后应能从快照解析出运行配置')

    // 换账号：目录里已经是另一个人的订阅了。
    authorizer.clear()
    served = [subscription('sub-b')]

    assert.equal(authorizer.resolve('sub-a'), null, '清空后不能再解析出上一个身份的员工')
    assert.equal(await authorizer.authorize('sub-b') !== null, true)
    assert.equal(fetches, 2, 'TTL 窗口内也必须重新请求——这正是 C10')
    assert.equal(skills.invalidations(), 1, '技能缓存也要跟着丢')
  })

  it('authorize carries the skill paths, not just the resolved config', async () => {
    const directory = new EmployeeDirectory(async () => [subscription('sub-a')])
    const skills = fakeSkills()
    const authorizer = new EmployeeAuthorizer(session, directory, skills, GATEWAY)

    const authorized = await authorizer.authorize('sub-a')

    // 换成 resolve() 的结果会让排队过的 run 静默丢掉技能路径（C4 的注意事项）。
    assert.deepEqual(authorized?.additionalSkillPaths, ['/skills/a'])
    assert.equal(skills.prepared(), 1)
  })

  it('prepares skills using the selected employee identity and subscription', async () => {
    const selectedEmployees = [
      { ...subscription('sub-a'), employeeId: 'employee-a' },
      { ...subscription('sub-b'), employeeId: 'employee-b' },
    ]
    const directory = new EmployeeDirectory(async () => selectedEmployees)
    const requests: Array<Parameters<SkillProvisioner['prepare']>[0]> = []
    const skills: SkillProvisioner = {
      async prepare(input) {
        requests.push(input)
        return { skillPaths: [`/skills/${input.subscriptionId}/${input.employeeId}`] }
      },
      invalidate() {},
    }
    const authorizer = new EmployeeAuthorizer(session, directory, skills, GATEWAY)

    assert.deepEqual((await authorizer.authorize('sub-a'))?.additionalSkillPaths, ['/skills/sub-a/employee-a'])
    assert.deepEqual((await authorizer.authorize('sub-b'))?.additionalSkillPaths, ['/skills/sub-b/employee-b'])
    assert.deepEqual(requests.map(request => ({ subscriptionId: request.subscriptionId, employeeId: request.employeeId })), [
      { subscriptionId: 'sub-a', employeeId: 'employee-a' },
      { subscriptionId: 'sub-b', employeeId: 'employee-b' },
    ])
  })

  it('returns null without preparing skills when the subscription is unknown', async () => {
    const directory = new EmployeeDirectory(async () => [subscription('sub-a')])
    const skills = fakeSkills()
    const authorizer = new EmployeeAuthorizer(session, directory, skills, GATEWAY)

    assert.equal(await authorizer.authorize('sub-missing'), null)
    assert.equal(skills.prepared(), 0, '未授权的订阅不该触发技能下载')
  })
})





describe('explicit model selection', () => {
  it('uses only a selected model that the subscription allows', () => {
    const employee = { ...subscription('sub-a'), allowedModels: ['first', 'selected'] }
    assert.equal(resolveEmployeeRuntime([employee], 'sub-a', GATEWAY, 'selected')?.modelId, 'selected')
    assert.equal(resolveEmployeeRuntime([employee], 'sub-a', GATEWAY, 'forbidden'), null)
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function runtimeManifest() {
  return {
    manifestVersion: 1, subscriptionId: 'sub-a', templateVersion: 'locked-template',
    employee: { id: 'template-', name: 'Employee', version: 'actual-employee', maxSteps: 10 },
    runtime: { systemPrompt: 'Actual employee prompt', modelId: 'preferred', allowedModels: ['first', 'preferred'],
      skills: [{ capabilityId: 'cap-a', name: 'Orders', description: null, versionId: 'approved-v1', version: '1.0', content: '# Approved source' }] },
  }
}

function preparedSkill(): PreparedEmployeeSkill {
  const content = '---\nname: cap-a\ndescription: Orders\n---\n# Actual owner source'
  return {
    capabilityId: 'cap-a', versionId: 'local-personal', baseSkillVersionId: 'approved-v1', version: 'personal', source: 'owner-local',
    name: 'cap-a', description: 'Orders', content, sha256: digest(content), path: '/skills/immutable/cap-a',
  }
}

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function artifactManifest() {
  const manifest = runtimeManifest()
  const content = '---\nname: cap-a\ndescription: Orders\n---\n# Approved source\n'
  const artifact: SkillArtifactAvailable = {
    protocolVersion: 1, status: 'AVAILABLE', capabilityId: 'cap-a', versionId: 'approved-v1',
    approvedContentSha256: digest(content), format: 'single-file', installationDirectory: 'cap-a',
    entryPath: 'SKILL.md', entrySha256: digest(content), artifactSha256: digest(content),
    byteLength: Buffer.byteLength(content), fileCount: 1,
    downloadPath: '/client/subscriptions/sub-a/skills/cap-a/versions/approved-v1/artifact',
  }
  return { ...manifest, runtime: { ...manifest.runtime, skillArtifactProtocolVersion: 1 as const,
    skills: [{ ...manifest.runtime.skills[0]!, content, artifact }] } }
}

function approvedPreparedSkill(manifest = artifactManifest()): PreparedEmployeeSkill & { artifact: SkillArtifactAvailable } {
  const runtime = manifest.runtime.skills[0]!
  return { ...preparedSkill(), source: 'approved', versionId: `platform-${runtime.versionId}`,
    baseSkillVersionId: runtime.versionId, version: runtime.version, content: runtime.content,
    sha256: digest(runtime.content), artifact: { ...runtime.artifact } }
}

function artifactAuthorizer(
  manifest: unknown,
  prepare: SkillProvisioner['prepare'],
  currentSession = session,
) {
  const directory = new EmployeeDirectory(async () => [{ ...subscription('sub-a'), allowedModels: ['first', 'preferred'] }])
  return new EmployeeAuthorizer(currentSession, directory, { prepare, invalidate() {} }, GATEWAY, {
    async getRuntime() { return manifest },
  })
}

describe('approved skill artifact authorization', () => {
  it('passes the negotiated protocol and freezes the complete approved descriptor and entry', async () => {
    const manifest = artifactManifest()
    const actual = approvedPreparedSkill(manifest)
    const authorizer = artifactAuthorizer(manifest, async input => {
      assert.equal(input.skillArtifactProtocolVersion, 1)
      assert.deepEqual(input.runtimeSkills, manifest.runtime.skills)
      return { skillPaths: [actual.path], skills: [actual] }
    })
    const result = await authorizer.authorize('sub-a')
    assert.equal(result?.runtimeSnapshot?.skillArtifactProtocolVersion, 1)
    assert.deepEqual(result?.runtimeSnapshot?.approvedSkills[0]?.artifact, manifest.runtime.skills[0]!.artifact)
    assert.deepEqual(result?.runtimeSnapshot?.skills[0]?.artifact, actual.artifact)
    assert.ok(Object.isFrozen(result?.runtimeSnapshot?.skills[0]?.artifact))
    assert.ok(Object.isFrozen(result?.runtimeSnapshot?.approvedSkills[0]?.artifact))
    actual.artifact.entrySha256 = 'b'.repeat(64)
    manifest.runtime.skills[0]!.artifact.artifactSha256 = 'c'.repeat(64)
    const frozenArtifact = result?.runtimeSnapshot?.skills[0]?.artifact
    assert.equal(frozenArtifact?.status, 'AVAILABLE')
    assert.notEqual(frozenArtifact?.status === 'AVAILABLE' ? frozenArtifact.entrySha256 : undefined, actual.artifact.entrySha256)
    assert.notEqual(result?.runtimeSnapshot?.approvedSkills[0]?.artifact?.artifactSha256, manifest.runtime.skills[0]!.artifact.artifactSha256)
  })

  it('does not let the provisioner replace the authorized version or descriptor before freezing', async () => {
    const manifest = artifactManifest()
    const actual = approvedPreparedSkill(manifest)
    const authorizer = artifactAuthorizer(manifest, async input => {
      assert.throws(() => { input.runtimeSkills![0]!.versionId = 'substituted-version' }, TypeError)
      const artifact = input.runtimeSkills![0]!.artifact as SkillArtifactAvailable
      assert.throws(() => { artifact.artifactSha256 = 'b'.repeat(64) }, TypeError)
      return { skillPaths: [actual.path], skills: [actual] }
    })
    assert.ok(await authorizer.authorize('sub-a'))
  })

  it('rejects missing, blocked, mismatched or unnegotiated descriptors before skill IO', async () => {
    const manifest = artifactManifest()
    const skill = manifest.runtime.skills[0]!
    const { artifact: _artifact, ...withoutArtifact } = skill
    const { skillArtifactProtocolVersion: _protocol, ...withoutProtocol } = manifest.runtime
    const invalidRuntimes = [
      { ...manifest.runtime, skills: [withoutArtifact] },
      { ...withoutProtocol, skills: [skill] },
      { ...manifest.runtime, skills: [{ ...skill, artifact: {
        protocolVersion: 1, status: 'BLOCKED', capabilityId: skill.capabilityId, versionId: skill.versionId,
        approvedContentSha256: skill.artifact.approvedContentSha256, reason: 'PACKAGE_REQUIRED',
      } }] },
      ...[
        { capabilityId: 'cap-other' }, { versionId: 'approved-other' },
        { approvedContentSha256: digest(skill.content.trim()) },
      ].map(patch => ({ ...manifest.runtime, skills: [{ ...skill, artifact: { ...skill.artifact, ...patch } }] })),
    ]
    let preparations = 0
    for (const runtime of invalidRuntimes) {
      const authorizer = artifactAuthorizer({ ...manifest, runtime }, async () => {
        preparations++
        return { skillPaths: [], skills: [] }
      })
      await assert.rejects(authorizer.authorize('sub-a'), /artifact|manifest/i)
    }
    assert.equal(preparations, 0)
  })

  it('preserves protocol negotiation for employees without skills and never downgrades a failed download', async () => {
    const manifest = artifactManifest()
    const empty = { ...manifest, runtime: { ...manifest.runtime, skills: [] } }
    const authorizer = artifactAuthorizer(empty, async input => {
      assert.equal(input.skillArtifactProtocolVersion, 1)
      assert.deepEqual(input.runtimeSkills, [])
      return { skillPaths: [], skills: [] }
    })
    assert.equal((await authorizer.authorize('sub-a'))?.runtimeSnapshot?.skillArtifactProtocolVersion, 1)
    let downloads = 0
    const failed = artifactAuthorizer(manifest, async () => {
      downloads++
      throw new Error('Artifact download denied.')
    })
    await assert.rejects(failed.authorize('sub-a'), /Artifact download denied/)
    assert.equal(downloads, 1)
  })

  it('rejects a prepared approved entry from another version or with forged content', async () => {
    const manifest = artifactManifest()
    const actual = approvedPreparedSkill(manifest)
    for (const patch of [
      { baseSkillVersionId: 'approved-other' }, { version: 'another-label' },
      { sha256: 'b'.repeat(64) }, { content: `${actual.content}changed` },
      { content: `${actual.content}changed`, sha256: digest(`${actual.content}changed`) },
      { artifact: undefined },
    ]) {
      const forged = { ...actual, ...patch }
      const authorizer = artifactAuthorizer(manifest, async () => ({ skillPaths: [forged.path], skills: [forged] }))
      await assert.rejects(authorizer.authorize('sub-a'), /prepared|artifact/i)
    }
  })

  it('requires every field of the complete prepared descriptor to match the approved descriptor', async () => {
    const manifest = artifactManifest()
    const actual = approvedPreparedSkill(manifest)
    const artifact = actual.artifact!
    const descriptorChanges: Partial<SkillArtifactAvailable>[] = [
      { capabilityId: 'cap-other' }, { versionId: 'approved-other' },
      { approvedContentSha256: 'b'.repeat(64) }, { format: 'zip' },
      { installationDirectory: 'another-name' }, { entryPath: 'nested/SKILL.md' },
      { entrySha256: 'b'.repeat(64) }, { artifactSha256: 'b'.repeat(64) },
      { byteLength: artifact.byteLength + 1 }, { fileCount: artifact.fileCount + 1 },
      { downloadPath: '/client/subscriptions/sub-other/skills/cap-a/versions/approved-v1/artifact' },
    ]
    for (const change of descriptorChanges) {
      const forged = { ...actual, artifact: { ...artifact, ...change } }
      const authorizer = artifactAuthorizer(manifest, async () => ({ skillPaths: [forged.path], skills: [forged] }))
      await assert.rejects(authorizer.authorize('sub-a'), /prepared|artifact/i, JSON.stringify(change))
    }
  })

  it('allows owner-local content but never labels an approved descriptor as owner-local', async () => {
    const manifest = artifactManifest()
    const local = preparedSkill()
    const authorizer = artifactAuthorizer(manifest, async input => {
      assert.equal(input.skillArtifactProtocolVersion, 1)
      return { skillPaths: [local.path], skills: [local] }
    })
    const result = await authorizer.authorize('sub-a')
    assert.equal(result?.runtimeSnapshot?.skills[0]?.source, 'owner-local')
    assert.equal(result?.runtimeSnapshot?.skills[0]?.artifact, undefined)
    assert.deepEqual(result?.runtimeSnapshot?.approvedSkills[0]?.artifact, manifest.runtime.skills[0]!.artifact)
    for (const forged of [
      { ...local, artifact: manifest.runtime.skills[0]!.artifact },
      { ...local, sha256: 'b'.repeat(64) },
    ]) {
      const invalid = artifactAuthorizer(manifest, async () => ({ skillPaths: [forged.path], skills: [forged] }))
      await assert.rejects(invalid.authorize('sub-a'), /prepared|artifact/i)
    }
  })

  it('requires a one-to-one correspondence between approved skills, prepared entries and execution paths', async () => {
    const manifest = artifactManifest()
    const actual = approvedPreparedSkill(manifest)
    for (const skillPaths of [[actual.path, '/skills/unapproved'], [actual.path, actual.path], []]) {
      const authorizer = artifactAuthorizer(manifest, async () => ({ skillPaths, skills: [actual] }))
      await assert.rejects(authorizer.authorize('sub-a'), /not fully prepared/)
    }
    const second = { ...manifest.runtime.skills[0]!, capabilityId: 'cap-b', versionId: 'approved-v2',
      artifact: { ...manifest.runtime.skills[0]!.artifact, capabilityId: 'cap-b', versionId: 'approved-v2',
        downloadPath: '/client/subscriptions/sub-a/skills/cap-b/versions/approved-v2/artifact' } }
    const secondActual = { ...actual, capabilityId: 'cap-b', baseSkillVersionId: 'approved-v2', artifact: second.artifact }
    const twoSkills = { ...manifest, runtime: { ...manifest.runtime, skills: [...manifest.runtime.skills, second] } }
    for (const skills of [[actual, actual], [actual, secondActual]]) {
      const authorizer = artifactAuthorizer(twoSkills, async () => ({ skillPaths: skills.map(skill => skill.path), skills }))
      await assert.rejects(authorizer.authorize('sub-a'), /not fully prepared/)
    }
    const empty = { ...manifest, runtime: { ...manifest.runtime, skills: [] } }
    await assert.rejects(artifactAuthorizer(empty, async () => ({ skillPaths: ['/skills/unapproved'], skills: [] })).authorize('sub-a'), /not fully prepared/)
  })

  it('rejects stale approved versions even on the legacy path', async () => {
    const actual = { ...preparedSkill(), source: 'approved' as const, baseSkillVersionId: 'another-approved-version' }
    const authorizer = artifactAuthorizer(runtimeManifest(), async () => ({ skillPaths: [actual.path], skills: [actual] }))
    await assert.rejects(authorizer.authorize('sub-a'), /not fully prepared/)
  })

  it('drops successful and failed artifact downloads after a member or generation change', async () => {
    for (const change of ['member', 'generation']) {
      for (const fail of [false, true]) {
        const manifest = artifactManifest()
        const actual = approvedPreparedSkill(manifest)
        const download = deferred<void>()
        const started = deferred<void>()
        let meta = { enterpriseId: 'enterprise-1', memberId: 'member-1' }
        let guard: (() => boolean) | undefined
        const authorizer = artifactAuthorizer(manifest, async input => {
          guard = input.isCurrent
          started.resolve()
          await download.promise
          if (fail) throw new Error('Artifact download failed.')
          return { skillPaths: [actual.path], skills: [actual] }
        }, { ...session, getMeta: () => meta })
        const pending = authorizer.authorize('sub-a')
        await started.promise
        if (change === 'member') meta = { ...meta, memberId: 'member-2' }
        else authorizer.clear()
        assert.equal(guard?.(), false)
        download.resolve()
        assert.equal(await pending, null)
      }
    }
  })
})

describe('C1 employee runtime preparation', () => {
  it('uses the runtime prompt/model and snapshots the actual selected skill, not the platform default', async () => {
    const manifest = runtimeManifest()
    const actual = preparedSkill()
    const requests: Array<Parameters<SkillProvisioner['prepare']>[0]> = []
    const skills: SkillProvisioner = {
      async prepare(input) { requests.push(input); return { skillPaths: [actual.path], skills: [actual] } },
      invalidate() {},
    }
    const directory = new EmployeeDirectory(async () => [{ ...subscription('sub-a'), allowedModels: ['first', 'preferred'] }])
    let runtimeFetches = 0
    const provider: RuntimeProvider = { async getRuntime(id, token) { assert.equal(id, 'sub-a'); assert.equal(token, 'access-token'); runtimeFetches++; return manifest } }
    const authorizer = new EmployeeAuthorizer(session, directory, skills, GATEWAY, provider)
    const result = await authorizer.authorize('sub-a')
    assert.equal(result?.modelId, 'preferred')
    assert.equal(result?.systemPrompt, manifest.runtime.systemPrompt)
    assert.equal(result?.runtimeSnapshot?.templateVersion, 'locked-template')
    assert.equal(result?.runtimeSnapshot?.employeeVersion, 'actual-employee')
    assert.deepEqual(result?.runtimeSnapshot?.skills, [actual])
    assert.deepEqual(requests[0]?.runtimeSkills, manifest.runtime.skills)
    assert.equal(requests[0]?.isCurrent?.(), true)
    assert.equal(employeeRuntimeSnapshotSchema.safeParse(result?.runtimeSnapshot).success, true)
    actual.content = '# Later mutation'
    manifest.runtime.skills[0]!.content = '# Later platform mutation'
    assert.notEqual(result?.runtimeSnapshot?.skills[0]?.content, actual.content)
    assert.notEqual(result?.runtimeSnapshot?.approvedSkills[0]?.content, manifest.runtime.skills[0]?.content)
    assert.equal(Object.isFrozen(result?.runtimeSnapshot?.skills[0]), true)
    authorizer.resolve('sub-a')
    assert.equal(runtimeFetches, 1, 'resolve must not perform runtime IO')
  })

  it('passes raw media without advertising or negotiating a capability', async () => {
    const manifest = runtimeManifest()
    const media = { mock: true }
    const directory = new EmployeeDirectory(async () => [{ ...subscription('sub-a'), allowedModels: ['first', 'preferred'] }])
    const skills: SkillProvisioner = { async prepare() { return { skillPaths: [], skills: [] } }, invalidate() {} }
    const authorizer = new EmployeeAuthorizer(session, directory, skills, GATEWAY, {
      async getRuntime() { return { ...manifest, runtime: { ...manifest.runtime, skills: [], media } } },
    })
    assert.deepEqual((await authorizer.authorize('sub-a'))?.media, media)
  })

  it('checks selected models against both runtime and directory before skill IO', async () => {
    const manifest = runtimeManifest()
    const skills = fakeSkills()
    const directory = new EmployeeDirectory(async () => [{ ...subscription('sub-a'), allowedModels: ['first', 'preferred', 'directory-only'] }])
    const authorizer = new EmployeeAuthorizer(session, directory, skills, GATEWAY, { async getRuntime() { return manifest } })
    assert.equal(await authorizer.authorize('sub-a', 'directory-only'), null)
    manifest.runtime.allowedModels = []
    assert.equal(await authorizer.authorize('sub-a'), null)
    assert.equal(skills.prepared(), 0)
  })

  for (const preferred of ['retired', 'unavailable']) {
    it(`selects a shared default when runtime default ${preferred} is not in the current directory`, async () => {
      const manifest = runtimeManifest()
      manifest.runtime.modelId = preferred
      manifest.runtime.allowedModels = ['retired', 'preferred', 'current']
      manifest.runtime.skills = []
      const directory = new EmployeeDirectory(async () => [{ ...subscription('sub-a'), allowedModels: ['directory-only', 'current'] }])
      let prepared = 0
      const skills: SkillProvisioner = { async prepare() { prepared++; return { skillPaths: [], skills: [] } }, invalidate() {} }
      const authorizer = new EmployeeAuthorizer(session, directory, skills, GATEWAY, { async getRuntime() { return manifest } })
      const employee = await authorizer.authorize('sub-a')
      assert.equal(employee?.modelId, 'current')
      assert.equal(employee?.runtimeSnapshot?.modelId, 'current')
      assert.equal(prepared, 1)
      assert.equal(await authorizer.authorize('sub-a', preferred), null, 'Explicit model choices must not silently fall back')
      assert.equal(prepared, 1)
    })
  }

  it('rejects disjoint model permissions without preparing skills', async () => {
    const manifest = runtimeManifest()
    const skills = fakeSkills()
    const directory = new EmployeeDirectory(async () => [subscription('sub-a', 'directory-only')])
    const authorizer = new EmployeeAuthorizer(session, directory, skills, GATEWAY, { async getRuntime() { return manifest } })
    assert.equal(await authorizer.authorize('sub-a'), null)
    assert.equal(skills.prepared(), 0)
  })

  it('rejects unsupported or mismatched manifests without preparing skills', async () => {
    const manifest = runtimeManifest()
    const skills = fakeSkills()
    const directory = new EmployeeDirectory(async () => [{ ...subscription('sub-a'), allowedModels: ['first', 'preferred'] }])
    for (const invalid of [
      { ...manifest, manifestVersion: 2 },
      { ...manifest, subscriptionId: 'another-subscription' },
      { ...manifest, employee: { ...manifest.employee, id: 'another-employee' } },
    ]) {
      const authorizer = new EmployeeAuthorizer(session, directory, skills, GATEWAY, { async getRuntime() { return invalid } })
      await assert.rejects(authorizer.authorize('sub-a'), /manifest|identity mismatch/)
    }
    assert.equal(skills.prepared(), 0)
  })

  it('fails explicitly when the provisioner omits an approved runtime skill', async () => {
    const directory = new EmployeeDirectory(async () => [{ ...subscription('sub-a'), allowedModels: ['first', 'preferred'] }])
    const authorizer = new EmployeeAuthorizer(session, directory, fakeSkills(), GATEWAY, { async getRuntime() { return runtimeManifest() } })
    await assert.rejects(authorizer.authorize('sub-a'), /not fully prepared/)
  })

  it('rejects authorization with no scope or an inactive subscription', async () => {
    const skills = fakeSkills()
    const directory = new EmployeeDirectory(async () => [subscription('sub-a')])
    const noScope = new EmployeeAuthorizer({ ...session, getMeta() { return null } }, directory, skills, GATEWAY)
    assert.equal(await noScope.authorize('sub-a'), null)
    assert.equal(resolveEmployeeRuntime([{ ...subscription('sub-a'), status: 'PAUSED' }], 'sub-a', GATEWAY), null)
    assert.equal(skills.prepared(), 0)
  })

  it('drops results when scope changes while obtaining a token', async () => {
    const token = deferred<string>()
    let meta = { enterpriseId: 'enterprise-1', memberId: 'member-1' }
    let directoryReads = 0
    const directory = new EmployeeDirectory(async () => { directoryReads++; return [subscription('sub-a')] })
    const authorizer = new EmployeeAuthorizer({ getValidAccessToken: () => token.promise, getMeta: () => meta }, directory, fakeSkills(), GATEWAY)
    const pending = authorizer.authorize('sub-a')
    meta = { enterpriseId: 'enterprise-2', memberId: 'member-2' }
    token.resolve('new-token')
    assert.equal(await pending, null)
    assert.equal(directoryReads, 0)
  })

  it('drains old directory requests and never admits old subscriptions into a new account', async () => {
    const oldDirectory = deferred<Subscription[]>()
    const started = deferred<void>()
    let meta = { enterpriseId: 'enterprise-1', memberId: 'member-1' }
    let reads = 0
    const directory = new EmployeeDirectory(async () => {
      reads++
      if (reads === 1) { started.resolve(); return oldDirectory.promise }
      return [subscription('sub-b')]
    })
    const authorizer = new EmployeeAuthorizer({ ...session, getMeta: () => meta }, directory, fakeSkills(), GATEWAY)
    const old = authorizer.authorize('sub-a')
    await started.promise
    authorizer.clear()
    meta = { enterpriseId: 'enterprise-2', memberId: 'member-2' }
    const next = authorizer.authorize('sub-b')
    oldDirectory.resolve([subscription('sub-a')])
    assert.equal(await old, null)
    assert.ok(await next)
    assert.equal(reads, 2)
    assert.equal(authorizer.resolve('sub-a'), null)
    assert.ok(authorizer.resolve('sub-b'))
  })

  it('drops old runtime responses after clear even when the same member signs in again', async () => {
    const runtime = deferred<unknown>()
    const started = deferred<void>()
    const directory = new EmployeeDirectory(async () => [{ ...subscription('sub-a'), allowedModels: ['first', 'preferred'] }])
    const skills = fakeSkills()
    const authorizer = new EmployeeAuthorizer(session, directory, skills, GATEWAY, {
      getRuntime() { started.resolve(); return runtime.promise },
    })
    const pending = authorizer.authorize('sub-a')
    await started.promise
    authorizer.clear()
    runtime.resolve(runtimeManifest())
    assert.equal(await pending, null)
    assert.equal(skills.prepared(), 0)
    assert.equal(authorizer.resolve('sub-a'), null)
  })

  it('provides an invalidation guard and discards stale skill preparations', async () => {
    const preparation = deferred<{ skillPaths: string[] }>()
    const started = deferred<void>()
    let guard: (() => boolean) | undefined
    const skills: SkillProvisioner = {
      prepare(input) { guard = input.isCurrent; started.resolve(); return preparation.promise }, invalidate() {},
    }
    const directory = new EmployeeDirectory(async () => [subscription('sub-a')])
    const authorizer = new EmployeeAuthorizer(session, directory, skills, GATEWAY)
    const pending = authorizer.authorize('sub-a')
    await started.promise
    authorizer.clear()
    assert.equal(guard?.(), false)
    preparation.resolve({ skillPaths: ['/old-account/skill'] })
    assert.equal(await pending, null)
  })
})
