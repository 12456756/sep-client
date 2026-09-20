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
} from './employee-authorizer'

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
