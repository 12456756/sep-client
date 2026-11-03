import { randomUUID } from 'node:crypto'
import type { ScheduledIssue, ScheduledOccurrence, ScheduledRunStatus } from '../../src/shared/scheduled-tasks'
import type { ScheduledRepository } from '../data/scheduled-task-store'
import type { TaskOwnerScope } from '../data/scope-path'
import { classifyScheduledError } from '../domain/scheduled-task'
import { AppError } from '../errors/app-error'
import { logger } from '../common/logger'
import { withTimeout } from '../common/with-timeout'

const log = logger.child('scheduled-dispatcher')
const active = new Set<ScheduledRunStatus>(['preparing', 'launching', 'running', 'waiting_approval', 'cancelling'])
const terminal = new Set<ScheduledRunStatus>(['completed', 'failed', 'cancelled', 'timed_out', 'missed'])
export interface ScheduledRunnerPort {
  prepare(run: ScheduledOccurrence, guard: () => void): Promise<void>
  launch(run: ScheduledOccurrence, guard: () => void): Promise<void>
  inspect(run: ScheduledOccurrence): Promise<{ state: 'pending' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'interrupted' | 'missing'; error?: ScheduledIssue }>
  cancel(run: ScheduledOccurrence): Promise<void>
  conflicts?(left: ScheduledOccurrence, right: ScheduledOccurrence): Promise<boolean>
}
/** Only the adapter can certify that the failed call never admitted an Agent. */
export class BeforeScheduledAdmissionError extends Error {
  constructor(readonly failure: unknown) { super('Scheduled execution was not admitted'); this.name = 'BeforeScheduledAdmissionError' }
}
export class ScheduledDispatcher {
  private readonly admissions = new Map<string, { cancelled: boolean }>()
  constructor(private readonly repository: ScheduledRepository, private readonly runner: ScheduledRunnerPort,
    private readonly now: () => number, private readonly scope: () => TaskOwnerScope | null) {}
  private assertScope(scope: TaskOwnerScope): void {
    const current = this.scope()
    if (current?.memberId !== scope.memberId || current.enterpriseId !== scope.enterpriseId) throw new AppError('AUTH_REQUIRED')
  }
  private async change(scope: TaskOwnerScope, id: string, mutate: (run: ScheduledOccurrence) => void): Promise<ScheduledOccurrence> {
    const run = await this.repository.update(scope, data => {
      this.assertScope(scope)
      const run = data.occurrences.find(item => item.id === id)
      if (!run) throw new AppError('NOT_FOUND')
      mutate(run)
      return run
    })
    log.info(`========== [SCHEDULED TASK] STATE ${run.status.toUpperCase()} ==========`, {
      scheduledTaskId: run.definitionId, occurrenceId: run.id, taskId: run.taskId,
      attemptId: run.attempts.at(-1)?.id, status: run.status, errorCode: run.error?.code ?? null,
      nextRetryAt: run.nextRetryAt, startedAt: run.startedAt, finishedAt: run.finishedAt,
    })
    return run
  }
  async recover(scope: TaskOwnerScope): Promise<void> {
    for (const run of (await this.repository.read(scope)).occurrences) {
      if (run.status === 'preparing' || run.status === 'waiting_auth') {
        log.warn('========== [SCHEDULED TASK] RECOVERY REQUEUE ==========', {
          scheduledTaskId: run.definitionId, occurrenceId: run.id, taskId: run.taskId, previousStatus: run.status,
        })
        await this.change(scope, run.id, item => {
          item.status = 'pending'; item.nextRetryAt = null
          const attempt = item.attempts.at(-1)
          if (attempt && !attempt.finishedAt) { attempt.status = 'interrupted'; attempt.finishedAt = this.now() }
        })
      } else if (active.has(run.status)) {
        log.warn('========== [SCHEDULED TASK] RECOVERY RECONCILE ==========', {
          scheduledTaskId: run.definitionId, occurrenceId: run.id, taskId: run.taskId, previousStatus: run.status,
        })
        if (run.status === 'launching') {
          const result = await this.runner.inspect(run)
          if (result.state === 'completed') await this.finish(scope, run.id, 'completed')
          else await this.review(scope, run.id)
        } else await this.reconcile(scope, run)
      }
    }
  }
  async scan(scope: TaskOwnerScope, guard: () => void): Promise<void> {
    let data = await this.repository.read(scope)
    for (const run of data.occurrences.filter(item => active.has(item.status))) { guard(); await this.reconcile(scope, run) }
    data = await this.repository.read(scope)
    for (const run of data.occurrences.filter(item => ['pending', 'waiting_retry', 'waiting_auth', 'blocked'].includes(item.status))) {
      guard()
      if (this.now() >= run.startDeadline) { await this.finish(scope, run.id, 'failed', { code: 'START_DEADLINE_EXCEEDED', message: '等待启动已超时，本次没有重新执行。', action: 'blocked' }); continue }
      if (['waiting_auth', 'blocked'].includes(run.status) || (run.nextRetryAt !== null && run.nextRetryAt > this.now())) continue
      // One scheduled execution at a time; uncertain work keeps only its resource reservation.
      let occupied = data.occurrences.some(item => item.id !== run.id && active.has(item.status))
      if (!occupied) for (const uncertain of data.occurrences.filter(item => item.id !== run.id && item.status === 'review')) {
        if (!this.runner.conflicts || await this.runner.conflicts(uncertain, run)) { occupied = true; break }
      }
      guard()
      if (occupied) {
        await this.change(scope, run.id, item => {
          item.status = 'waiting_retry'; item.nextRetryAt = Math.min(this.now() + 30000, item.startDeadline)
          item.error = { code: 'CONFLICT', message: '等待其他任务结束或不确定操作完成核查。', action: 'retry' }
        })
        continue
      }
      const claimed = await this.change(scope, run.id, item => {
        if (!['pending', 'waiting_retry'].includes(item.status)) throw new AppError('INVALID_STATE')
        item.status = 'preparing'; item.error = null; item.nextRetryAt = null
        item.attempts.push({ id: randomUUID(), number: item.attempts.length + 1, startedAt: this.now(), finishedAt: null, status: 'preparing', error: null })
      })
      log.info('========== [SCHEDULED TASK] PREFLIGHT START ==========', {
        scheduledTaskId: claimed.definitionId, occurrenceId: claimed.id, taskId: claimed.taskId,
        attemptId: claimed.attempts.at(-1)?.id, attemptNumber: claimed.attempts.at(-1)?.number,
        mode: claimed.input.mode ?? 'employee', planKind: claimed.plan.kind,
      })
      let failureStage: 'preflight' | 'runtime-admission' = 'preflight'
      try {
        let setupExpired = false
        const setupGuard = () => { guard(); if (setupExpired) throw new AppError('INVALID_STATE') }
        try { await withTimeout(this.runner.prepare(claimed, setupGuard), 60000, 'scheduled-prepare') }
        catch (error) {
          setupExpired = true
          if (error instanceof Error && error.name === 'TimeoutError') throw { code: 'SERVICE_UNAVAILABLE' }
          throw error
        }
        guard()
        log.info('========== [SCHEDULED TASK] PREFLIGHT PASSED ==========', {
          scheduledTaskId: claimed.definitionId, occurrenceId: claimed.id, taskId: claimed.taskId,
          attemptId: claimed.attempts.at(-1)?.id,
        })
        const launch = await this.change(scope, run.id, item => {
          if (item.status !== 'preparing') throw new AppError('INVALID_STATE')
          item.status = 'launching'
        })
        failureStage = 'runtime-admission'
        try {
          let expired = false
          const admission = { cancelled: false }
          this.admissions.set(run.id, admission)
          try { await withTimeout(this.runner.launch(launch, () => { guard(); if (expired || admission.cancelled) throw new AppError('INVALID_STATE') }), 60000, 'scheduled-admission') }
          finally { expired = true; this.admissions.delete(run.id) }
        } catch (error) {
          if (error instanceof BeforeScheduledAdmissionError) throw error.failure
          await this.review(scope, run.id)
          return
        }
        guard()
        log.info('========== [SCHEDULED TASK] RUNTIME ADMITTED ==========', {
          scheduledTaskId: launch.definitionId, occurrenceId: launch.id, taskId: launch.taskId,
          attemptId: launch.attempts.at(-1)?.id,
        })
        await this.change(scope, run.id, item => {
          if (item.status !== 'launching') return
          item.status = 'running'; item.startedAt = this.now(); item.attempts.at(-1)!.status = 'admitted'
        })
      } catch (error) {
        guard()
        const issue = classifyScheduledError(error)
        log.warn('========== [SCHEDULED TASK] START FAILED ==========', {
          scheduledTaskId: claimed.definitionId, occurrenceId: claimed.id, taskId: claimed.taskId,
          attemptId: claimed.attempts.at(-1)?.id, errorCode: issue.code, action: issue.action,
          stage: failureStage,
          errorType: error instanceof Error ? error.name : typeof error,
        })
        await this.change(scope, run.id, item => {
          if (!['preparing', 'launching'].includes(item.status)) return
          const attempt = item.attempts.at(-1)!
          attempt.status = 'failed'; attempt.finishedAt = this.now(); attempt.error = issue; item.error = issue
          const delay = Math.max(issue.retryAfterMs ?? 0, Math.min(60000, 5000 * 2 ** (attempt.number - 1)) * (0.8 + Math.random() * 0.4))
          if (issue.action === 'retry' && attempt.number < 4 && this.now() + delay < item.startDeadline) {
            item.status = 'waiting_retry'; item.nextRetryAt = this.now() + Math.ceil(delay)
          } else if (issue.action === 'auth') item.status = 'waiting_auth'
          else if (issue.action === 'blocked') item.status = 'blocked'
          else if (issue.action === 'review') item.status = 'review'
          else { item.status = 'failed'; item.finishedAt = this.now() }
        })
      }
      return
    }
  }
  private async reconcile(scope: TaskOwnerScope, run: ScheduledOccurrence): Promise<void> {
    const result = await this.runner.inspect(run)
    this.assertScope(scope)
    if (result.state === 'completed') {
      await this.finish(scope, run.id, run.stopReason ?? 'completed')
    } else if (result.state === 'failed') {
      await this.finish(scope, run.id, run.stopReason ?? 'failed', result.error)
    } else if (result.state === 'interrupted' || result.state === 'missing') {
      await this.review(scope, run.id)
    } else if (run.status === 'cancelling') {
      if (result.state === 'pending') await this.finish(scope, run.id, run.stopReason ?? 'cancelled')
      else if (this.now() - (run.nextRetryAt ?? this.now()) > 15000) await this.review(scope, run.id)
    } else if ((run.startedAt !== null && this.now() - run.startedAt >= 3600000) || (run.startedAt === null && this.now() >= run.startDeadline)) {
      const stopping = await this.change(scope, run.id, item => { item.status = 'cancelling'; item.stopReason = 'timed_out'; item.nextRetryAt = this.now() })
      await withTimeout(this.runner.cancel(stopping), 15000, 'scheduled-stop').catch(() => this.review(scope, run.id))
    } else if (result.state === 'waiting_approval' && run.status !== 'waiting_approval') {
      await this.change(scope, run.id, item => { item.status = 'waiting_approval' })
    } else if (result.state === 'running' && run.status === 'waiting_approval') {
      await this.change(scope, run.id, item => { item.status = 'running' })
    }
  }
  private async review(scope: TaskOwnerScope, id: string): Promise<void> {
    const run = await this.change(scope, id, item => {
      if (terminal.has(item.status)) return
      item.status = 'review'; item.nextRetryAt = null; item.error = { code: 'EXECUTION_UNCERTAIN', action: 'review', message: '执行已中断或状态不确定。已禁止自动重跑，请核查已有文件和操作结果。' }
    })
    log.error('========== [SCHEDULED TASK] EXECUTION STATE UNCERTAIN ==========', {
      scheduledTaskId: run.definitionId, occurrenceId: run.id, taskId: run.taskId,
      attemptId: run.attempts.at(-1)?.id, decision: 'automatic-replay-disabled',
    })
  }
  private async finish(scope: TaskOwnerScope, id: string, status: ScheduledRunStatus, error?: ScheduledIssue): Promise<void> {
    await this.change(scope, id, item => {
      if (terminal.has(item.status)) return
      item.status = status; item.finishedAt = this.now(); item.nextRetryAt = null; item.error = error ?? null
      const attempt = item.attempts.at(-1)
      if (attempt && !attempt.finishedAt) { attempt.finishedAt = this.now(); attempt.status = status === 'completed' ? 'completed' : 'failed'; attempt.error = error ?? null }
    })
  }
  async cancel(scope: TaskOwnerScope, id: string): Promise<void> {
    const admission = this.admissions.get(id)
    if (admission) admission.cancelled = true
    const run = await this.change(scope, id, item => {
      if (['completed', 'cancelled', 'timed_out', 'failed', 'missed'].includes(item.status)) throw new AppError('INVALID_STATE')
      if (['pending', 'waiting_retry', 'waiting_auth', 'blocked', 'preparing'].includes(item.status)) {
        item.status = 'cancelled'; item.finishedAt = this.now(); item.nextRetryAt = null
        const attempt = item.attempts.at(-1)
        if (attempt && !attempt.finishedAt) { attempt.status = 'interrupted'; attempt.finishedAt = this.now() }
      } else { item.status = 'cancelling'; item.stopReason = 'cancelled'; item.nextRetryAt = this.now() }
    })
    if (run.status === 'cancelling') await withTimeout(this.runner.cancel(run), 15000, 'scheduled-cancel').catch(() => this.review(scope, run.id))
  }
}
