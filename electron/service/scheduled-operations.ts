import { createHash } from 'node:crypto'
import type { ScheduledIssue, ScheduledOccurrence, ScheduledOperation, ScheduledOrigin } from '../../src/shared/scheduled-tasks'
import type { ScheduledRepository } from '../data/scheduled-task-store'
import type { TaskOwnerScope } from '../data/scope-path'
import type { ConnectorCommandResult, ScheduledToolExecution } from '../domain/connectors'
import { ConnectorInputError } from '../domain/connectors'
export const scheduledFilePublicationTool = 'scheduled_file_publish'

function operationIdentity(_key: string, value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
}

export async function trackScheduledFilePublication(options: {
  repository: ScheduledRepository; scope: TaskOwnerScope; run: ScheduledOccurrence; name: string;
  guard(): void; publish(reconcileOnly?: boolean): Promise<void>; isUncertain(error: unknown): boolean;
}): Promise<void> {
  const { repository, scope, run, name, guard, publish, isUncertain } = options
  const key = createHash('sha256').update(JSON.stringify([scheduledFilePublicationTool, run.input.outputDirectory?.identity, name.normalize('NFC').toLowerCase()])).digest('hex')
  const find = (data: Awaited<ReturnType<ScheduledRepository['read']>>) => data.occurrences.find(item => item.id === run.id && item.revision === run.revision)
  const started = await repository.update(scope, data => {
    guard()
    const current = find(data)
    if (!current || !['running', 'launching', 'waiting_approval', 'cancelling'].includes(current.status)) throw new Error('Scheduled publication is not active.')
    const operations = current.operations ??= []
    const existing = operations.find(item => item.key === key)
    if (existing) return existing.status
    if (operations.length >= 256) throw new Error('Scheduled operation limit reached.')
    const status = current.stopReason ? 'not-executed' : 'submitting'
    operations.push({ key, tool: scheduledFilePublicationTool, ...(/^[^\p{Cc}\p{Bidi_Control}]{1,256}$/u.test(name) ? { target: name } : {}),
      status, ...(current.stopReason ? { reason: 'cancelled' } : {}) })
    return status === 'submitting' ? 'started' : status
  })
  if (started !== 'started' && started !== 'submitting') return
  let result: Pick<ScheduledOperation, 'status' | 'reason'>
  try {
    await publish(started === 'submitting')
    result = { status: 'succeeded' }
  } catch (error) {
    result = started === 'submitting' || isUncertain(error)
      ? { status: 'unknown', reason: 'submission-uncertain' }
      : { status: 'not-executed', reason: 'file-not-published' }
  }
  await repository.update(scope, data => {
    guard()
    const entry = find(data)?.operations?.find(item => item.key === key && item.status === 'submitting')
    if (!entry) throw new Error('Scheduled publication no longer active.')
    Object.assign(entry, result)
  })
}

function reasonForResult(result: ConnectorCommandResult): ScheduledOperation['reason'] {
  return result.scheduledReason ?? (result.executionUncertain ? 'submission-uncertain' : result.notExecuted ? 'not-attempted' : result.isError ? 'platform-rejected' : undefined)
}

export function scheduledOperationIssue(run: ScheduledOccurrence): ScheduledIssue | undefined {
  if (run.operations?.some(item => item.status === 'unknown' || item.status === 'submitting')) {
    return { code: 'SCHEDULED_OPERATION_UNKNOWN', action: 'review', message: '外部操作结果待核实。本次不会自动重发，请查看执行记录。' }
  }
  if (run.operations?.some(item => item.status === 'failed')) {
    return { code: 'SCHEDULED_OPERATION_FAILED', action: 'fail', message: '至少一项外部操作未成功，请查看执行记录。' }
  }
  if (run.operations?.some(item => item.status === 'not-executed')) return {
    code: 'SCHEDULED_OPERATION_NOT_EXECUTED', action: 'fail', message: '至少一项外部操作未执行，请查看执行记录。',
  }
}

export class ScheduledOperations {
  constructor(private readonly repository: ScheduledRepository, private readonly currentScope: () => TaskOwnerScope | null) {}

  bind(scope: TaskOwnerScope, origin: ScheduledOrigin, taskId: string, planHash: string): ScheduledToolExecution {
    const currentOwner = () => {
      const current = this.currentScope()
      return current?.memberId === scope.memberId && current.enterpriseId === scope.enterpriseId
    }
    const occurrence = (data: Awaited<ReturnType<ScheduledRepository['read']>>) => data.occurrences.find(run =>
      run.id === origin.occurrenceId && run.definitionId === origin.definitionId && run.taskId === taskId && `${run.id}:${run.revision}` === planHash)
    const active = (data: Awaited<ReturnType<ScheduledRepository['read']>>, signal?: AbortSignal) => {
      const run = occurrence(data)
      const definition = data.definitions.find(item => item.id === origin.definitionId)
      return currentOwner() && !signal?.aborted && run && !run.stopReason && ['launching', 'running'].includes(run.status)
        && definition && !definition.deleted && definition.revision === run.revision && definition.pausedAt == null ? run : undefined
    }
    const recordBlocked: NonNullable<ScheduledToolExecution['recordBlocked']> = async (tool, reason) => {
      const safeTool = /^[a-z0-9_]{1,120}$/i.test(tool) ? tool : 'scheduled_unsupported_tool'
      const key = createHash('sha256').update(JSON.stringify(['scheduled-blocked', safeTool, reason])).digest('hex')
      await this.repository.update(scope, data => {
        const run = occurrence(data)
        if (!currentOwner() || !run || !['launching', 'running', 'cancelling'].includes(run.status)) return
        const operations = run.operations ??= []
        if (operations.length < 256 && !operations.some(item => item.key === key)) operations.push({ key, tool: safeTool, status: 'not-executed', reason })
      })
    }
    return { isActive: async signal => !!active(await this.repository.read(scope), signal), recordBlocked, issue: async () => {
      if (!currentOwner()) throw new Error('Scheduled operation owner changed.')
      const run = occurrence(await this.repository.read(scope))
      if (!currentOwner() || !run) throw new Error('Scheduled operation occurrence unavailable.')
      return scheduledOperationIssue(run)
    }, submit: async (tool, operation, signal, invoke) => {
      const key = createHash('sha256').update(JSON.stringify([tool, operation.identity], operationIdentity)).digest('hex')
      const target = operation.target && /^[^\p{Cc}\p{Bidi_Control}]{1,256}$/u.test(operation.target) ? operation.target : undefined
      const entry = { key, tool, ...(target ? { target } : {}), ...(operation.dingTalkAction ? { dingTalkAction: operation.dingTalkAction } : {}) }
      const started = await this.repository.update(scope, data => {
        const run = active(data, signal)
        if (!run) return 'inactive'
        const operations = run.operations ??= []
        const existing = operations.find(item => item.key === key)
        if (existing) return existing.status === 'submitting' ? 'unknown' : existing.status
        // A separate explicit recipient can still be served. Do not assume that
        // writes to the same recipient, or writes with no recipient, are independent.
        if (operations.some(item => (item.status === 'unknown' || item.status === 'submitting') &&
          (!entry.target || !item.target || item.tool !== entry.tool || item.target === entry.target))) return 'blocked-by-uncertain'
        if (operations.length >= 256) return 'limit'
        operations.push({ ...entry, status: 'submitting' })
        return 'started'
      })
      if (started !== 'started') return started === 'succeeded'
        ? { text: '该操作在本次定时任务中已成功，不再重复提交。', isError: false }
        : started === 'unknown' ? { text: '先前提交结果待核实，未再次提交。', isError: true, executionUncertain: true }
        : started === 'blocked-by-uncertain' ? { text: '操作未执行：无法确认与先前待核实的操作相互独立。', isError: true, notExecuted: true }
        : { text: '操作未执行：本次执行已停止、已达操作上限或已有失败记录。', isError: true, notExecuted: true }

      let result: Awaited<ReturnType<typeof invoke>> = { text: '操作未执行：任务已取消或账户已变化。', isError: true, notExecuted: true, scheduledReason: 'cancelled' }
      if (currentOwner() && !signal?.aborted) {
        const latest = await this.repository.read(scope).catch(() => undefined)
        if (!latest) result = { text: '操作未执行：无法确认当前定时任务仍可执行。', isError: true, notExecuted: true }
        else if (active(latest, signal)?.operations?.some(item => item.key === key && item.status === 'submitting')) {
          try { result = await invoke() }
          catch (error) {
            result = error instanceof ConnectorInputError ? { text: `操作未执行：${error.message}`, isError: true, notExecuted: true, scheduledReason: 'target-unverified' }
              : { text: '外部操作结果待核实，请勿重发。', isError: true, executionUncertain: true }
          }
        }
      }
      try {
        await this.repository.update(scope, data => {
          if (!currentOwner()) throw new Error('Scheduled operation owner changed.')
          const entry = occurrence(data)?.operations?.find(item => item.key === key)
          if (!entry || entry.status !== 'submitting') throw new Error('Scheduled operation no longer active.')
          entry.status = result.executionUncertain ? 'unknown' : result.notExecuted ? 'not-executed' : result.isError ? 'failed' : 'succeeded'
          const reason = reasonForResult(result)
          if (reason) entry.reason = reason
        })
      } catch {
        return { text: '无法保存外部操作结果，请核实后处理，不自动重发。', isError: true, executionUncertain: true }
      }
      return result
    } }
  }
}
