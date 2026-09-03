/**
 * C10 — 身份变化必须丢掉平台目录的 TTL 缓存
 *
 * Phase 1 的 C4 给 `GET /client/subscriptions` 加了 15 秒 TTL 缓存，但只有"认证失效"
 * 这一条路径会把它丢掉；登录与登出只清了内存快照与技能包缓存。
 * `InstanceDirectory` 的缓存不按身份分键，于是"登出后 15 秒内换账号登录"会让
 * `authorize()` 读到上一个账号的订阅列表。
 *
 * 修复方式是让 `EmployeeAccess` 只有一个身份收尾入口 `clear()`，三条路径共用。
 * 下面两个用例分别盯住"入口本身做对了"与"三条路径都走了这个入口"。
 */
import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { EmployeeInstanceSnapshot } from '../../src/shared/types'
import { EmployeeAccess } from './employee-access'

const here = dirname(fileURLToPath(import.meta.url))

function subscription(id: string): EmployeeInstanceSnapshot {
  return {
    id,
    name: `employee-${id}`,
    status: 'ACTIVE',
    templateVersion: '1.0.0',
    template: { id: `template-${id}`, name: `template-${id}`, avatar: null },
    department: null,
    allowedModels: ['sep-employee'],
  }
}

/** 只实现 EmployeeAccess 真正用到的四个方法，并记下 invalidate 被调了几次。 */
function fakeDirectory(instances: EmployeeInstanceSnapshot[]) {
  let invalidations = 0
  let served = instances
  let cached: EmployeeInstanceSnapshot[] = []
  return {
    invalidations: () => invalidations,
    serve(next: EmployeeInstanceSnapshot[]) { served = next },
    async list() { cached = served; return cached },
    async refresh() { cached = served; return cached },
    snapshot() { return cached },
    invalidate() { invalidations += 1; cached = [] },
  }
}

const session = {
  async getValidAccessToken() { return 'access-token' },
  getMeta() { return { enterpriseId: 'enterprise-1' } },
}

describe('C10 — 身份变化丢弃平台目录缓存', () => {
  it('clear() drops the snapshot and the platform directory cache together', async () => {
    const directory = fakeDirectory([subscription('sub-a')])
    const employees = new EmployeeAccess(session, directory, await mkdtemp(join(tmpdir(), 'sep-c10-')))

    await employees.refresh()
    assert.ok(employees.resolve('sub-a'), '刷新后应能从快照解析出运行配置')

    employees.clear()

    assert.equal(employees.resolve('sub-a'), null, '清空后不能再解析出上一个身份的员工')
    assert.equal(directory.invalidations(), 1, '平台目录的 TTL 缓存也必须丢掉——这正是 C10')
  })

  it('routes login, logout and auth invalidation through the same entry point', () => {
    const composition = readFileSync(join(here, 'composition-root.ts'), 'utf8')
    const main = readFileSync(join(here, '..', 'main.ts'), 'utf8')

    // 修复前登录/登出走的是一个"只清一半"的变体。只允许存在 clear() 一个入口。
    assert.doesNotMatch(
      composition,
      /\breset\(\)/,
      'EmployeeAccess 不该再有第二个只清一半的收尾入口（C10）',
    )
    // 登出与认证失效在组装根内，登录在 main.ts 的 handler 里。
    assert.equal(
      (composition.match(/this\.employees\.clear\(\)/g) ?? []).length,
      2,
      'signOut 与 invalidateAuthentication 各一次',
    )
    assert.match(main, /backend\.employees\.clear\(\)/, '登录成功后也必须丢掉上一个身份的目录缓存')
  })
})
