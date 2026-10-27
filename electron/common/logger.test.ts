import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { isLogLevelEnabled, logger, setLogLevel, setLogSink, type LogRecord } from './logger'

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

  it('hides trace noise while keeping new content and exposes it only when requested', () => {
    capture()
    setLogLevel('debug')
    const log = logger.child('gateway')
    log.trace('hook entered')
    log.debug('new input')
    assert.deepEqual(captured.map(record => record.message), ['new input'])
    setLogLevel('trace')
    log.trace('hook entered')
    assert.equal(captured.at(-1)?.level, 'trace')
  })

  it('allows callers to skip building disabled log bodies', () => {
    setLogLevel('info')
    assert.equal(isLogLevelEnabled('debug'), false)
    assert.equal(isLogLevelEnabled('info'), true)
    setLogLevel('debug')
    assert.equal(isLogLevelEnabled('debug'), true)
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

  it('does not render legacy model input bodies in the console', () => {
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { logger, setLogLevel } from './electron/common/logger.ts';
      setLogLevel('debug');
      logger.child('pi-gateway').debug('model input added: user', {
        inputSequence: 42, role: 'user',
        content: 'First line\\nSecond line\\nAuthorization: Bearer private-value',
        reasoning: 'Third line\\nFourth line',
        accessToken: 'never-print-this',
      });
    `], { encoding: 'utf8', cwd: process.cwd() })
    assert.equal(output, '')
  })

  it('prints Chinese request summaries without bodies or dense diagnostic identifiers', () => {
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { logger, setLogLevel } from './electron/common/logger.ts';
      setLogLevel('debug');
      logger.child('pi-gateway').info('model response completed', {
        requestId: 28, outputLimit: 4096, contentLength: 0,
        thinkingLength: 8395, estimatedThinkingTokens: 2906,
        usage: { input: 62902, output: 4096 },
      });
      logger.child('pi-gateway').debug('model response content', { requestId: 28, content: 'Short answer' });
    `], { encoding: 'utf8', cwd: process.cwd() })
    assert.match(output, /\d{2}:\d{2}:\d{2}｜模型响应完成/)
    assert.match(output, /输入 62902｜输出 4096/)
    assert.doesNotMatch(output, /Short answer|requestId|estimatedThinkingTokens/)
  })

  it('keeps multiline log length limits and does not reinterpret literal backslashes', () => {
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { logger, setLogLevel } from './electron/common/logger.ts';
      setLogLevel('debug');
      logger.child('ordinary-module').info('long message', { content: 'First line\\n' + 'x'.repeat(9000) + 'HIDDEN_TAIL' });
      logger.child('ordinary-module').info('path', { content: String.raw\`C:\\new\\test.txt\` });
    `], { encoding: 'utf8', cwd: process.cwd() })
    assert.ok(output.includes('content:\nFirst line\n'))
    assert.match(output, /\[truncated\]/)
    assert.doesNotMatch(output, /HIDDEN_TAIL/)
    assert.doesNotMatch(output, /C:\n/)
    assert.ok(output.includes('new'))
  })

  it('suppresses all legacy input, thinking and output blocks even at trace level', () => {
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { logger, setLogLevel } from './electron/common/logger.ts';
      setLogLevel('trace');
      const log = logger.child('pi-gateway');
      log.debug('model input added: user', {
        displayTitle: '模型输入（用户消息）', inputSequence: 1,
        content: '请生成演示文稿。\\n保留真实换行。\\nBearer private-input',
      });
      log.debug('model response thinking', {
        displayTitle: '模型思考', requestId: 1, content: '思考第一行。\\n第二行。\\nBearer private-thinking',
      });
      log.debug('model response content', {
        displayTitle: '模型输出', requestId: 1, content: '正在制作演示文稿。\\nBearer private-output',
      });
    `], { encoding: 'utf8', cwd: process.cwd() })
    assert.equal(output, '')
  })
})

