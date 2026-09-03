/**
 * 应用启动与停机路径的源码级断言（C3 / C7）
 *
 * Electron 不 await 生命周期监听器的返回值，所以"停机是否真的收干净"没法在运行时
 * 单测——进程要么已经退出，要么没有。能守的只有接线方式，参照
 * pi/sdk/sdk-boundary.test.ts 的做法：那条边界同样是一旦写错就崩在启动路径上、
 * 无法用运行时测试覆盖。
 *
 * 停机时 in-flight 副作用工具必须产出 SIDE_EFFECT_UNKNOWN 这一行为本身，
 * 由 runtime/concurrency-invariants.test.ts 的 I7 覆盖。
 * 协调器惰性加载的并发/失败语义由 common/lazy-async.test.ts 用运行时测试覆盖。
 */
import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const electronDir = join(here, '..')

function read(...segments: string[]): string {
  return readFileSync(join(electronDir, ...segments), 'utf8')
}

const mainSource = read('main.ts')
const shutdownSource = read('bootstrap', 'shutdown.ts')
const compositionSource = read('bootstrap', 'composition-root.ts')
const bridgeSource = read('bootstrap', 'renderer-bridge.ts')

describe('app shutdown wiring', () => {
  it('does not hang an async listener off will-quit', () => {
    for (const [name, source] of [['main.ts', mainSource], ['shutdown.ts', shutdownSource]] as const) {
      assert.doesNotMatch(
        source,
        /app\.on\(\s*['"]will-quit['"]\s*,\s*async/,
        `${name}: will-quit 是同步事件，async 监听器会在第一个 await 处被丢下`,
      )
    }
  })

  it('takes over quitting with before-quit + preventDefault', () => {
    assert.match(shutdownSource, /app\.on\(\s*['"]before-quit['"]/, '必须接管 before-quit')
    assert.match(shutdownSource, /event\.preventDefault\(\)/, '必须先拦住默认退出')
    assert.match(shutdownSource, /app\.exit\(0\)/, '收尾后必须显式退出，否则应用退不掉')
  })

  it('bounds the shutdown budget', () => {
    const budget = /SHUTDOWN_BUDGET_MS\s*=\s*([\d_]+)/.exec(shutdownSource)
    assert.ok(budget, '停机预算必须是一个具名常量')
    const milliseconds = Number(budget[1]!.replaceAll('_', ''))
    assert.ok(milliseconds > 0 && milliseconds <= 30_000, `停机预算 ${milliseconds}ms 不合理`)
    assert.match(shutdownSource, /settleWithTimeout\(stop\(\)/, '停机必须走有界等待')
  })

  it('registers the shutdown handler with the assembled backend', () => {
    assert.match(
      mainSource,
      /installShutdownHandler\(\{[\s\S]*?stop: \(\) => backend\.stopAll\(\)/,
      '停机必须接到组装好的后端上，否则 before-quit 时没有可收的对象',
    )
  })
})

describe('startup ordering', () => {
  it('opens the window only after the backend is assembled', () => {
    const composed = mainSource.indexOf('await createBackend({')
    // 带分号才是调用点；函数声明是 `openMainWindow(): void`，不能算进来。
    const opened = mainSource.indexOf('openMainWindow();')
    assert.ok(composed >= 0, 'whenReady 必须 await createBackend()')
    assert.ok(opened > composed, '窗口必须在组装成功之后才创建（C3）')
  })

  it('surfaces an assembly failure instead of leaving a broken window', () => {
    assert.match(mainSource, /reportFatal\(\s*'无法启动任务运行时'/, '组装失败必须弹中文错误框')
    assert.match(mainSource, /app\.exit\(1\)/, '组装失败后不能继续开窗')
  })

  it('makes an uncaught exception visible, not just logged', () => {
    // 不传 onFatal 的话 uncaughtException 只留一条日志，用户面对的是一个状态已不可信
    // 却毫无提示的应用——第 4.3 节「致命错误可见」只兑现了初始化失败那一半。
    assert.match(
      mainSource,
      /installProcessHandlers\(\{\s*onFatal:/,
      'installProcessHandlers 必须接上 onFatal',
    )
    assert.match(mainSource, /function presentFatalOnce\(/, '致命错误呈现必须收成一个入口')
    assert.match(
      mainSource,
      /if \(fatalPresented\) return/,
      'showErrorBox 是模态的，反复触发的异常不能弹第二次',
    )
  })

  it('keeps ipc registration behind a successful assembly', () => {
    const composed = mainSource.indexOf('await createBackend({')
    const registered = mainSource.indexOf('registerIpcHandlers(backend)')
    assert.ok(registered > composed, 'handler 必须在 backend 就绪之后注册，才不需要判空')
  })
})

describe('authentication invalidation', () => {
  it('bounds the cleanup instead of waiting on stopAll forever (C7)', () => {
    const budget = /AUTH_CLEANUP_BUDGET_MS\s*=\s*([\d_]+)/.exec(compositionSource)
    assert.ok(budget, '认证失效清理预算必须是一个具名常量')
    const milliseconds = Number(budget[1]!.replaceAll('_', ''))
    assert.ok(milliseconds > 0 && milliseconds <= 30_000, `清理预算 ${milliseconds}ms 不合理`)
    assert.match(
      compositionSource,
      /settleWithTimeout\(\s*\r?\n?\s*this\.stopAll\(\)/,
      'stopAll 必须走有界等待，否则"重新登录"会永远卡住',
    )
  })

  it('routes every scope read through one entry point (C7/C9)', () => {
    const sources = { 'main.ts': mainSource, 'composition-root.ts': compositionSource }
    for (const [name, source] of Object.entries(sources)) {
      const direct = source.match(/getCurrentUserScope\(\)/g) ?? []
      const expected = name === 'composition-root.ts' ? 1 : 0
      assert.equal(direct.length, expected, `${name} 里应有 ${expected} 处直接读 scope，实际 ${direct.length} 处`)
    }
    assert.match(
      compositionSource,
      /authenticationInvalidating\(\): boolean/,
      '清理进行中必须能被识别，否则会在半清理状态上继续写数据',
    )
    assert.match(
      compositionSource,
      /currentScope\(\)[\s\S]*?this\.authenticationInvalidating\(\)/,
      '取 scope 必须先判失效中（C7）',
    )
  })
})

describe('renderer push has a single exit', () => {
  it('keeps webContents.send inside the renderer bridge', () => {
    assert.match(bridgeSource, /webContents\.send\(/, 'bridge 才是推送出口')
    for (const [name, source] of Object.entries({ 'main.ts': mainSource, 'composition-root.ts': compositionSource })) {
      assert.doesNotMatch(source, /webContents\.send\(/, `${name} 不该直接推给渲染进程（B1）`)
    }
  })
})
