import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { setLogSink, type LogRecord } from '../common/logger'
import { appError } from './app-error'
import { reportError, reportFailure, reportFatal, setFatalPresenter } from './error-reporter'
import { TaskPersistenceError } from '../runtime/task-manager'

const captured: LogRecord[] = []
let restore: (() => void) | null = null

function capture(): void {
  captured.length = 0
  restore = setLogSink(record => { captured.push(record) })
}

afterEach(() => {
  restore?.()
  restore = null
  setFatalPresenter(null)
})

describe('reportError', () => {
  it('picks the log level from the error code table, not from the caller', () => {
    capture()
    reportError('task:execute', new TaskPersistenceError())
    reportError('task:get', appError('NOT_FOUND'))
    assert.deepEqual(captured.map(record => record.level), ['error', 'warn'])
  })

  it('keeps technical detail in the log and out of the envelope', () => {
    capture()
    const envelope = reportError('auth:login', new Error('ECONNRESET calling Bearer abc'), { attempt: 2 })

    assert.equal(envelope.code, 'INTERNAL_ERROR')
    assert.ok(!envelope.message.includes('ECONNRESET'), '技术细节泄漏到了 IPC 载荷')
    assert.ok(!/[A-Za-z]{6,}/.test(envelope.message), `信封文案应为中文：${envelope.message}`)

    const fields = captured[0]?.fields ?? {}
    assert.equal(fields['operation'], 'auth:login')
    assert.equal(fields['code'], 'INTERNAL_ERROR')
    assert.equal(fields['attempt'], 2)
    assert.equal(String(fields['cause']).includes('ECONNRESET'), true, '日志里应保留技术细节')
    assert.equal(String(fields['cause']).includes('Bearer abc'), false, '日志里的令牌未脱敏')
  })

  it('carries AppError details into the log only', () => {
    capture()
    const envelope = reportError('task:create', appError('INVALID_ARGUMENT', {
      message: '工作目录不合法。',
      details: { field: 'workDir' },
    }))
    assert.equal(envelope.message, '工作目录不合法。')
    assert.deepEqual(captured[0]?.fields['details'], { field: 'workDir' })
    assert.equal(JSON.stringify(envelope).includes('workDir'), false, 'details 不得进 IPC 载荷')
  })

  it('does not leak the authenticated flag into the log fields', () => {
    capture()
    reportError('task:execute', new Error('x'), { authenticated: true, taskId: 'task-a' })
    assert.deepEqual(Object.keys(captured[0]?.fields ?? {}).sort(), ['cause', 'code', 'operation', 'taskId'])
  })
})

describe('reportFailure', () => {
  it('returns a ready-to-return IPC failure', () => {
    capture()
    const result = reportFailure('task:delete', appError('INVALID_STATE'))
    assert.equal(result.success, false)
    assert.equal(result.error.code, 'INVALID_STATE')
    assert.equal(captured.length, 1)
  })
})

describe('reportFatal', () => {
  it('shows the Chinese copy and logs the cause', () => {
    capture()
    const shown: Array<[string, string]> = []
    setFatalPresenter((title, message) => shown.push([title, message]))

    reportFatal('无法启动任务运行时', new Error('EACCES: permission denied'))

    assert.equal(shown.length, 1)
    assert.equal(shown[0]?.[0], '无法启动任务运行时')
    assert.ok(!shown[0]?.[1].includes('EACCES'), '弹框不该出现技术细节')
    assert.equal(captured[0]?.level, 'error')
    assert.equal(String(captured[0]?.fields['cause']).includes('EACCES'), true)
  })

  it('only logs when no presenter is installed', () => {
    capture()
    reportFatal('标题', new Error('boom'))
    assert.equal(captured.length, 1)
  })
})
