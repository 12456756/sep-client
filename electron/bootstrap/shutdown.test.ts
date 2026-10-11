/** 停机行为测试：执行真实 handler，注入 app、日志与有界等待替身。 */
import * as assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { describe, it, mock } from 'node:test'
import { fileURLToPath } from 'node:url'
import { compileFunction } from 'node:vm'
import * as ts from 'typescript'
import type { LogFields } from '../common/logger'
import { describeError } from '../common/redact'
import type { settleWithTimeout } from '../common/with-timeout'
import type { ShutdownOptions } from './shutdown'

type ShutdownModule = typeof import('./shutdown')
type ShutdownResult = Awaited<ReturnType<typeof settleWithTimeout>>

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject })
  return { promise, resolve, reject }
}

function setup(options: Omit<ShutdownOptions, 'stop'> = {}) {
  const stopWork = deferred<void>()
  const settlement = deferred<ShutdownResult>()
  const order: string[] = []
  const stop = mock.fn(() => { order.push('stop'); return stopWork.promise })
  const wait = mock.fn((work: Promise<unknown>, _timeoutMs: number, _operation: string) => {
    order.push('wait')
    // 模拟有界等待器接管 rejection；结算结果由测试控制，无需真实计时器。
    void work.catch(() => undefined)
    return settlement.promise
  })
  const app = Object.assign(new EventEmitter(), {
    exit: mock.fn((_code: number) => { order.push('exit') }),
  })
  const log = {
    info: mock.fn((_message: string, _fields?: LogFields) => undefined),
    error: mock.fn((_message: string, _fields?: LogFields) => undefined),
  }
  const dependencies: Record<string, unknown> = {
    electron: { app },
    '../common/logger': { logger: { child: (scope: string) => { assert.equal(scope, 'shutdown'); return log } } },
    '../common/redact': { describeError },
    '../common/with-timeout': { settleWithTimeout: wait },
  }
  const filename = fileURLToPath(new URL('./shutdown.ts', import.meta.url))
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText
  const module = { exports: {} }
  const requireStub = (id: string): unknown => {
    assert.ok(Object.hasOwn(dependencies, id), `unexpected runtime import: ${id}`)
    return dependencies[id]
  }
  compileFunction(compiled, ['require', 'exports', 'module'], { filename })(requireStub, module.exports, module)
  const shutdown = module.exports as ShutdownModule
  shutdown.installShutdownHandler({ ...options, stop })

  function quit() {
    const event = { preventDefault: mock.fn(() => { order.push('preventDefault') }) }
    assert.equal(app.emit('before-quit', event), true)
    return event
  }

  return { app, log, order, quit, shutdown, stop, stopWork, settlement, wait }
}

/** 让 handler 的 then/finally 完成，不使用实际停机预算或固定 sleep。 */
async function flushShutdown(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}

describe('shutdown behavior', () => {
  it('lets the native updater quit without intercepting or cleaning up once installation is prepared', async () => {
    const isUpdateInstallPrepared = mock.fn(() => true)
    const describeState = mock.fn(() => ({ activeRuns: 1 }))
    const harness = setup({ isUpdateInstallPrepared, describeState })
    const first = harness.quit()
    const second = harness.quit()
    await flushShutdown()

    assert.equal(isUpdateInstallPrepared.mock.callCount(), 2)
    assert.equal(first.preventDefault.mock.callCount(), 0)
    assert.equal(second.preventDefault.mock.callCount(), 0)
    assert.equal(harness.stop.mock.callCount(), 0)
    assert.equal(harness.wait.mock.callCount(), 0)
    assert.equal(harness.app.exit.mock.callCount(), 0)
    assert.equal(describeState.mock.callCount(), 0)
    assert.equal(harness.log.info.mock.callCount(), 0)
    assert.equal(harness.log.error.mock.callCount(), 0)
  })

  for (const prepared of [undefined, false] as const) {
    it(prepared === undefined
      ? 'intercepts ordinary quits and waits for cleanup before exiting when no update predicate is supplied'
      : 'cleans up normally when update installation has not been prepared', async () => {
      const isUpdateInstallPrepared = prepared === undefined ? undefined : mock.fn(() => prepared)
      const state = { activeRuns: 2 }
      const describeState = mock.fn(() => state)
      const harness = setup({ isUpdateInstallPrepared, describeState })
      const event = harness.quit()

      assert.equal(event.preventDefault.mock.callCount(), 1)
      assert.deepEqual(harness.order, ['preventDefault', 'stop', 'wait'])
      assert.equal(harness.stop.mock.callCount(), 1)
      assert.equal(harness.wait.mock.callCount(), 1)
      assert.deepEqual(harness.wait.mock.calls[0].arguments, [harness.stopWork.promise, 5_000, 'shutdown'])
      assert.equal(harness.shutdown.SHUTDOWN_BUDGET_MS, 5_000)
      assert.equal(describeState.mock.callCount(), 1)
      assert.equal(harness.log.info.mock.calls[0].arguments[1], state)
      if (isUpdateInstallPrepared) assert.equal(isUpdateInstallPrepared.mock.callCount(), 1)
      await flushShutdown()
      assert.equal(harness.app.exit.mock.callCount(), 0)

      harness.stopWork.resolve()
      harness.settlement.resolve({ ok: true })
      await flushShutdown()
      assert.deepEqual(harness.order, ['preventDefault', 'stop', 'wait', 'exit'])
      assert.deepEqual(harness.app.exit.mock.calls.map(call => call.arguments), [[0]])
      assert.equal(harness.log.error.mock.callCount(), 0)
    })
  }

  it('reads preparation status on every quit attempt instead of latching an earlier updater bypass', async () => {
    let prepared = true
    const harness = setup({ isUpdateInstallPrepared: () => prepared })
    const updaterQuit = harness.quit()
    assert.equal(updaterQuit.preventDefault.mock.callCount(), 0)
    assert.equal(harness.stop.mock.callCount(), 0)

    prepared = false
    const normalQuit = harness.quit()
    assert.equal(normalQuit.preventDefault.mock.callCount(), 1)
    assert.equal(harness.stop.mock.callCount(), 1)
    assert.equal(harness.app.exit.mock.callCount(), 0)
    harness.stopWork.resolve()
    harness.settlement.resolve({ ok: true })
    await flushShutdown()
    assert.deepEqual(harness.app.exit.mock.calls.map(call => call.arguments), [[0]])
  })

  it('does not start duplicate cleanup when before-quit repeats while cleanup is pending', async () => {
    const harness = setup({ isUpdateInstallPrepared: () => false })
    harness.quit()
    harness.quit()
    await flushShutdown()
    assert.equal(harness.stop.mock.callCount(), 1)
    assert.equal(harness.wait.mock.callCount(), 1)
    assert.equal(harness.app.exit.mock.callCount(), 0)

    harness.stopWork.resolve()
    harness.settlement.resolve({ ok: true })
    await flushShutdown()
    assert.deepEqual(harness.app.exit.mock.calls.map(call => call.arguments), [[0]])
  })

  it('exits after the bounded wait times out even when cleanup is still pending', async () => {
    const harness = setup({ isUpdateInstallPrepared: () => false })
    const event = harness.quit()
    assert.equal(event.preventDefault.mock.callCount(), 1)
    assert.equal(harness.app.exit.mock.callCount(), 0)

    harness.settlement.resolve({ ok: false, timedOut: true, error: new Error('timeout') })
    await flushShutdown()
    assert.equal(harness.log.error.mock.callCount(), 1)
    const fields = harness.log.error.mock.calls[0].arguments[1]
    assert.equal(fields?.timedOut, true)
    assert.equal(fields?.budgetMs, 5_000)
    assert.equal(fields?.cause, undefined)
    assert.deepEqual(harness.app.exit.mock.calls.map(call => call.arguments), [[0]])
  })

  it('logs a sanitized cleanup failure and still exits', async () => {
    const harness = setup()
    const event = harness.quit()
    const error = new Error('cleanup failed with Bearer private-token')
    harness.stopWork.reject(error)
    harness.settlement.resolve({ ok: false, timedOut: false, error })
    await flushShutdown()

    assert.equal(event.preventDefault.mock.callCount(), 1)
    assert.equal(harness.log.error.mock.callCount(), 1)
    const fields = harness.log.error.mock.calls[0].arguments[1]
    assert.equal(fields?.timedOut, false)
    assert.equal(fields?.cause, 'Error: cleanup failed with Bearer [redacted]')
    assert.doesNotMatch(JSON.stringify(harness.log.error.mock.calls[0].arguments), /private-token/)
    assert.deepEqual(harness.app.exit.mock.calls.map(call => call.arguments), [[0]])
  })
})
