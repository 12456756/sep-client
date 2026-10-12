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
import type { Subscription } from '../../src/shared/types'
import { EmployeeDirectory } from './employee-directory'
import {
  EmployeeAuthorizer,
  resolveEmployeeRuntime,
  type SkillProvisioner,
  type RuntimeProvider,
} from './employee-authorizer'
import { employeeRuntimeSnapshotSchema, type PreparedEmployeeSkill } from '../common/platform/employee-runtime-contract'

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
    assert.deepEqual(result, { subscriptionId: 'sub-a', modelId: 'model-x', gatewayUrl: GATEWAY })
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
  return {
    capabilityId: 'cap-a', versionId: 'local-personal', baseSkillVersionId: 'approved-v1', version: 'personal', source: 'owner-local',
    name: 'cap-a', description: 'Orders', content: '---\nname: cap-a\ndescription: Orders\n---\n# Actual owner source', sha256: 'a'.repeat(64), path: '/skills/immutable/cap-a',
  }
}

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
