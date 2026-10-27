import { it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStatus, type TaskExecutionEvent } from '../../src/shared/types'
import { TaskManager } from './task-manager'
import { TaskRuntime } from './task-runtime'
import { TaskRunStore } from '../data/task-run-store'

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('Run did not settle')
}

for (const mode of ['timeout', 'retry-success', 'pause', 'cancel', 'shutdown', 'notice-delivery-failed'] as const) {
  it(`handles conversation ${mode} without losing its resumable session or repeating notices`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-runtime-feedback-'))
    const scope = { memberId: 'member', enterpriseId: 'enterprise' }
    const runs = new TaskRunStore(root)
    const manager = new TaskManager(root, null, undefined, runs)
    await manager.initialize()
    await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const task = await manager.createTask('conversation', 'first message', root, 'employee')
    const events: TaskExecutionEvent[] = []
    const controlled = ['pause', 'cancel', 'shutdown'].includes(mode)
    const fails = mode === 'timeout' || mode === 'notice-delivery-failed'
    const resumed: Array<string | undefined> = []
    let started = false
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    let attempts = 0
    const sessionFile = join(root, 'session.jsonl')
    const runtime = new TaskRuntime({
      taskManager: manager, taskRunStore: runs,
      getRefreshToken: () => 'fixture', onAuthenticationRequired() {}, onApprovalRequest() {}, onEvent: event => {
        events.push(event)
        if (mode === 'notice-delivery-failed' && event.type === 'run_failure_notice') throw new Error('renderer is unavailable')
      },
      resolveEmployee: subscriptionId => ({ subscriptionId, modelId: 'model', gatewayUrl: 'http://unused' }),
      createWorker: options => ({
        async run() {
          resumed.push(options.context.resumeSessionFile)
          await mkdir(root, { recursive: true })
          await writeFile(sessionFile, '{}\n', 'utf8')
          await options.onSessionCreated?.({ sessionId: 'session', sessionFile })
          started = true
          if (++attempts > 1) return
          const emit = (type: string, data: unknown) => options.onEvent({ taskId: task.id, runId: options.context.runId,
            subscriptionId: 'employee', sequence: 0, occurredAt: Date.now(), type, data })
          await emit('auto_retry_start', { attempt: 1, maxAttempts: 3, delayMs: 0, error: 'private gateway response' })
          if (controlled) { await blocked; throw new Error('Request timed out.') }
          await emit('auto_retry_end', { success: mode === 'retry-success', error: 'private gateway response' })
          if (fails) {
            await emit('session_error', { message: 'private gateway response' })
            throw new Error('Request timed out.')
          }
        }, async abort() { release() }, async dispose() {},
      }),
    })
    try {
      await runtime.executeTask(task.id, { conversation: true })
      if (controlled) {
        await waitFor(() => started)
        if (mode === 'shutdown') await runtime.stopAll()
        else if (mode === 'cancel') await runtime.cancelTask(task.id)
        else await runtime.pauseTask(task.id)
      }
      await waitFor(async () => (await manager.getTask(task.id))?.activeRunId === null)
      assert.equal((await manager.getTask(task.id))?.status, fails ? TaskStatus.FAILED : mode === 'shutdown' ? TaskStatus.INTERRUPTED : controlled ? TaskStatus.PAUSED : TaskStatus.COMPLETED)
      const notices = events.filter(event => event.type === 'run_failure_notice')
      assert.equal(notices.length, fails ? 1 : 0)
      if (fails) {
        assert.deepEqual(notices[0].data, { owner: scope, code: 'MODEL_TIMEOUT' })
        assert.equal((await runs.list(scope, task.id))[0].error, '模型请求超时，请稍后重试')
        await runtime.continueConversation(task.id, 'continue from the saved result')
        await waitFor(async () => (await manager.getTask(task.id))?.status === TaskStatus.COMPLETED)
        assert.deepEqual(resumed, [undefined, sessionFile])
        assert.equal(events.filter(event => event.type === 'run_failure_notice').length, 1)
      }
      assert.doesNotMatch(JSON.stringify(events), /private gateway response|Request timed out/)
      assert.doesNotMatch(JSON.stringify(await manager.getTask(task.id)), /private gateway response|Request timed out/)
    } finally { release(); await runtime.stopAll(); await rm(root, { recursive: true, force: true }) }
  })
}
