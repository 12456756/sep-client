/**
 * 应用停机路径的源码级断言（C3）
 *
 * Electron 不 await 生命周期监听器的返回值，所以"停机是否真的收干净"没法在运行时
 * 单测——进程要么已经退出，要么没有。能守的只有接线方式，参照 pi/sdk-boundary.test.ts
 * 的做法：那条边界同样是一旦写错就崩在启动路径上、无法用运行时测试覆盖。
 *
 * 停机时 in-flight 副作用工具必须产出 SIDE_EFFECT_UNKNOWN 这一行为本身，
 * 由 tasks/concurrency-invariants.test.ts 的 I7 覆盖。
 */
import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const mainSource = readFileSync(join(here, '..', 'main.ts'), 'utf8')

describe('app shutdown wiring', () => {
  it('does not hang an async listener off will-quit', () => {
    assert.doesNotMatch(
      mainSource,
      /app\.on\(\s*['"]will-quit['"]\s*,\s*async/,
      'will-quit 是同步事件，async 监听器会在第一个 await 处被丢下',
    )
  })

  it('takes over quitting with before-quit + preventDefault', () => {
    assert.match(mainSource, /app\.on\(\s*['"]before-quit['"]/, '必须接管 before-quit')
    assert.match(mainSource, /event\.preventDefault\(\)/, '必须先拦住默认退出')
    assert.match(mainSource, /app\.exit\(0\)/, '收尾后必须显式退出，否则应用退不掉')
  })

  it('bounds the shutdown budget', () => {
    const budget = /SHUTDOWN_BUDGET_MS\s*=\s*([\d_]+)/.exec(mainSource)
    assert.ok(budget, '停机预算必须是一个具名常量')
    const milliseconds = Number(budget[1]!.replaceAll('_', ''))
    assert.ok(milliseconds > 0 && milliseconds <= 30_000, `停机预算 ${milliseconds}ms 不合理`)
    assert.match(mainSource, /settleWithTimeout\(\s*stopAllAndDispose\(\)/, '停机必须走有界等待')
  })

  it('awaits task manager initialization instead of firing and forgetting', () => {
    assert.match(
      mainSource,
      /await ensureTaskManager\(\)/,
      '不 await 的话初始化失败会变成无人处理的 rejection，而窗口已经打开',
    )
  })
})

describe('authentication invalidation', () => {
  it('bounds the cleanup instead of waiting on stopAll forever (C7)', () => {
    const budget = /AUTH_CLEANUP_BUDGET_MS\s*=\s*([\d_]+)/.exec(mainSource)
    assert.ok(budget, '认证失效清理预算必须是一个具名常量')
    const milliseconds = Number(budget[1]!.replaceAll('_', ''))
    assert.ok(milliseconds > 0 && milliseconds <= 30_000, `清理预算 ${milliseconds}ms 不合理`)
    assert.match(
      mainSource,
      /settleWithTimeout\(\s*\r?\n?\s*taskCoordinator \? taskCoordinator\.stopAll\(\)/,
      'stopAll 必须走有界等待，否则"重新登录"会永远卡住',
    )
  })

  it('routes every scope guard through one entry point (C7/C9)', () => {
    const direct = mainSource.match(/getCurrentUserScope\(\)/g) ?? []
    assert.equal(
      direct.length,
      1,
      `main.ts 里应只有 requireScope 一处直接读 scope，实际 ${direct.length} 处`,
    )
    assert.match(
      mainSource,
      /function authenticationInvalidating\(\)/,
      '清理进行中必须能被识别，否则会在半清理状态上继续写数据',
    )
    assert.match(
      mainSource,
      /if \(authenticationInvalidating\(\)\) \{/,
      'requireScope 必须先判失效中',
    )
  })
})
