import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { logger, setLogLevel, setLogSink, type LogRecord } from './logger'

const captured: LogRecord[] = []
let restore: (() => void) | null = null

function capture(): void {
  captured.length = 0
  restore = setLogSink(record => { captured.push(record) })
}

afterEach(() => {
  restore?.()
  restore = null
  setLogLevel('debug')
})

describe('logger', () => {
  it('tags records with the child scope chain', () => {
    capture()
    setLogLevel('debug')
    const log = logger.child('tasks').child('runtime')
    log.info('run started', { runId: 'run-a' })
    assert.equal(captured.length, 1)
    assert.equal(captured[0]?.scope, 'tasks.runtime')
    assert.equal(captured[0]?.message, 'run started')
    assert.deepEqual(captured[0]?.fields, { runId: 'run-a' })
  })

  it('merges fields bound at child creation', () => {
    capture()
    logger.child('worker', { taskId: 'task-a' }).warn('slow', { elapsedMs: 12 })
    assert.deepEqual(captured[0]?.fields, { taskId: 'task-a', elapsedMs: 12 })
  })

  it('drops records below the active level', () => {
    capture()
    setLogLevel('warn')
    const log = logger.child('gate')
    log.debug('noise')
    log.info('noise')
    log.warn('kept')
    log.error('kept')
    assert.deepEqual(captured.map(record => record.level), ['warn', 'error'])
  })

  it('redacts every field before it leaves the process', () => {
    capture()
    logger.child('auth').error('refresh failed', {
      accessToken: 'super-secret',
      detail: 'Authorization: Bearer abc.def',
    })
    assert.deepEqual(captured[0]?.fields, {
      accessToken: '[redacted]',
      detail: 'Authorization: Bearer [redacted]',
    })
  })

  it('never writes a scope-less record', () => {
    capture()
    logger.child('module').info('message')
    assert.equal(captured[0]?.scope, 'module')
    assert.ok(captured[0]?.timestamp > 0)
  })
})

