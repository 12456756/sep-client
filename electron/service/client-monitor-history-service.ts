import { TaskStatus, type ClientTask, type TaskExecutionEvent } from '../../src/shared/types'
import { redactText } from '../common/redact'
import type { ConversationMessage } from '../domain/conversation-context'
import type { TaskOwnerScope } from '../data/scope-path'
import type { TaskRunRecord } from '../data/task-run-store'
import { isMonitorTerminal, type ClientTaskStatusRequest, type MonitorStatus, type ContentRecovery } from '../common/platform/client-monitor-contract'
import { finalResponseFromEvents } from '../../src/shared/run-response'

export interface MonitorHistoryRun {
  runId: string
  subscriptionId: string
  modelId: string
  prompt: string
  queuedAt?: number
  /** Positive evidence required to enrich an existing pending create. */
  localRun?: true
  messages: { type: 'user_input' | 'model_output'; content: string; occurredAt: number;
    messageId?: string; source?: 'canonical' | 'timeline' | 'snapshot'; completeness?: 'complete' | 'partial' | 'unverified' }[]
  status?: ClientTaskStatusRequest
  runEndedAt?: string
  recoveryReason?: ContentRecovery['reason']
}
export interface MonitorHistoryTask {
  taskId: string
  title: string
  taskType: 'conversation' | 'arrangement'
  runs: MonitorHistoryRun[]
}
export interface ClientMonitorHistorySource { read(scope: TaskOwnerScope): Promise<MonitorHistoryTask[]> }
export interface ClientMonitorHistoryOptions {
  scopeProvider: () => TaskOwnerScope | null
  listTasks: () => Promise<ClientTask[]>
  listRuns: (scope: TaskOwnerScope, taskId: string) => Promise<TaskRunRecord[]>
  listMessages: (scope: TaskOwnerScope, taskId: string) => Promise<ConversationMessage[]>
  getTimeline: (scope: TaskOwnerScope, taskId: string, runId: string) => Promise<TaskExecutionEvent[]>
  taskType?: (scope: TaskOwnerScope, taskId: string) => Promise<'conversation' | 'arrangement'>
}

const outcomeStatus: Record<TaskRunRecord['outcome'], MonitorStatus> = {
  running: 'RUNNING', completed: 'COMPLETED', failed: 'FAILED', cancelled: 'CANCELLED', stopped: 'PAUSED', interrupted: 'INTERRUPTED',
}
const snapshotStatus = (status: ClientTask['status']): MonitorStatus => status === TaskStatus.PENDING ? 'QUEUED' : status.toUpperCase() as MonitorStatus

/** Read-only recovery through existing stores. No filesystem traversal, execution or tool replay. */
export class ClientMonitorHistoryService implements ClientMonitorHistorySource {
  constructor(private readonly options: ClientMonitorHistoryOptions) {}

  async read(scope: TaskOwnerScope): Promise<MonitorHistoryTask[]> {
    const current = (): boolean => {
      const actual = this.options.scopeProvider()
      return actual?.enterpriseId === scope.enterpriseId && actual.memberId === scope.memberId
    }
    if (!current()) return []
    const tasks = await this.options.listTasks()
    if (!current()) return []
    const result: MonitorHistoryTask[] = []
    for (const task of tasks) {
      if (task.ownerId !== scope.memberId || task.ownerEnterpriseId !== scope.enterpriseId) continue
      let runs = await this.options.listRuns(scope, task.id)
      if (!current()) return []
      const messages = await this.options.listMessages(scope, task.id)
      if (!current()) return []
      const taskType = await this.options.taskType?.(scope, task.id) ?? 'conversation'
      if (!current()) return []
      const timelines = new Map<string, TaskExecutionEvent[]>()
      if (taskType === 'arrangement') {
        const children = new Set<string>()
        for (const run of runs) {
          const events = await this.options.getTimeline(scope, task.id, run.id)
          if (!current()) return []
          timelines.set(run.id, events)
          for (const event of events) {
            const data = object(event.data)
            if (event.type.startsWith('arrangement_node_') && typeof data.nodeRunId === 'string') children.add(data.nodeRunId)
          }
        }
        // Child workers are not top-level task runs; don't overwrite parent terminal status.
        runs = runs.filter(run => !children.has(run.id))
      }
      runs.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
      const recovered: MonitorHistoryRun[] = []
      for (const [index, run] of runs.entries()) {
        if (run.taskId !== task.id || !run.subscriptionId || run.owner.memberId !== scope.memberId || run.owner.enterpriseId !== scope.enterpriseId) continue
        const events = (timelines.get(run.id) ?? await this.options.getTimeline(scope, task.id, run.id))
          .filter(event => event.taskId === task.id && event.runId === run.id && event.subscriptionId === run.subscriptionId)
        if (!current()) return []
        // A settled successful run event, not canonical persistence alone, proves output completion.
        const finished = run.outcome === 'completed' && events.some(event => event.type === 'run_completed')
        const canonical = messages.filter(message => message.taskId === task.id && message.runId === run.id && message.subscriptionId === run.subscriptionId && (message.role === 'user' || message.role === 'assistant'))
          .sort((a, b) => a.createdAt - b.createdAt)
        const content: MonitorHistoryRun['messages'] = canonical.map(message => ({
          messageId: message.id, type: message.role === 'user' ? 'user_input' : 'model_output', content: message.content,
          occurredAt: message.createdAt, source: 'canonical',
          completeness: message.role === 'user' || (finished && canonical.filter(value => value.role === 'assistant').length === 1 && message.id === `${run.id}-assistant`) ? 'complete' : 'unverified',
        }))
        if (!content.some(message => message.type === 'user_input') && run.prompt) content.unshift({ messageId: `${run.id}-user`, type: 'user_input', content: run.prompt, occurredAt: run.startedAt, source: 'snapshot', completeness: 'complete' })
        if (!content.some(message => message.type === 'model_output')) {
          const output = taskType === 'arrangement'
            ? events.filter(event => event.type === 'arrangement_node_completed').map(event => object(event.data).output).filter((value): value is string => typeof value === 'string').join('\n\n')
            : finalResponseFromEvents(events)
          if (output.length > 0) content.push({ messageId: `${run.id}-assistant`, type: 'model_output', content: output, occurredAt: run.endedAt ?? run.startedAt, source: 'timeline', completeness: run.outcome === 'interrupted' || run.outcome === 'stopped' ? 'partial' : 'unverified' })
        }
        let status = outcomeStatus[run.outcome]
        // A snapshot label cannot override a persisted stopped/interrupted/terminal outcome.
        const snapshot = snapshotStatus(task.status)
        if (run.outcome === 'running' && index === runs.length - 1 && (!task.activeRunId || task.activeRunId === run.id) &&
          (snapshot === 'QUEUED' || snapshot === 'RUNNING' || snapshot === 'WAITING_APPROVAL')) status = snapshot
        const completedAt = localTimestamp(run.endedAt ?? (index === runs.length - 1 ? task.completedAt : null))
        recovered.push({ runId: run.id, subscriptionId: run.subscriptionId, modelId: run.modelId, prompt: run.prompt ?? '', messages: content, localRun: true,
          ...(completedAt !== undefined ? { runEndedAt: new Date(completedAt).toISOString() } : {}),
          ...(!content.some(message => message.type === 'model_output') && run.outcome !== 'running' ? { recoveryReason: 'source-missing' as const } : {}),
          // TaskRunStore writes startedAt when it creates the persisted run.
          queuedAt: localTimestamp(run.startedAt) ?? (index === 0 ? localTimestamp(task.createdAt) : undefined),
          status: { status, ...(status === 'COMPLETED' ? { progress: 100 } : {}),
            startedAt: localTimestamp(run.startedAt) === undefined ? null : new Date(run.startedAt).toISOString(), completedAt: isMonitorTerminal(status) && completedAt !== undefined ? new Date(completedAt).toISOString() : null,
            errorSummary: safeError(run.error ?? (index === runs.length - 1 ? task.error : null)),
          },
        })
      }
      if (recovered.length === 0 && runs.length === 0 && task.subscriptionId) {
        const orphanRuns = new Map<string, ConversationMessage[]>()
        for (const message of messages) {
          if (message.taskId !== task.id || !message.runId || !message.subscriptionId ||
            !message.id || localTimestamp(message.createdAt) === undefined || (message.role !== 'user' && message.role !== 'assistant')) continue
          const group = orphanRuns.get(message.runId) ?? []
          group.push(message)
          orphanRuns.set(message.runId, group)
        }
        for (const [runId, group] of orphanRuns) {
          // Conflicting employee bindings are not proof; never reattribute them.
          if (new Set(group.map(message => message.subscriptionId)).size !== 1) continue
          group.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
          recovered.push({ runId, subscriptionId: group[0].subscriptionId, modelId: group[0].modelId,
            prompt: group.find(message => message.role === 'user')?.content ?? '',
            messages: group.map(message => ({ messageId: message.id, type: message.role === 'user' ? 'user_input' : 'model_output', content: message.content, occurredAt: message.createdAt, source: 'canonical', completeness: message.role === 'user' ? 'complete' : 'unverified' })),
          })
        }
        if (recovered.length) {
          result.push({ taskId: task.id, title: task.title, taskType, runs: recovered })
          continue
        }
        const status = snapshotStatus(task.status)
        recovered.push({ runId: task.activeRunId ?? `history-${task.id}`, subscriptionId: task.subscriptionId, modelId: 'unknown', prompt: task.prompt, queuedAt: task.activeRunId ? undefined : localTimestamp(task.createdAt),
          messages: task.prompt ? [{ messageId: `snapshot-${task.id}-input`, type: 'user_input', content: task.prompt, occurredAt: task.createdAt, source: 'snapshot', completeness: 'unverified' }] : [],
          recoveryReason: messages.length ? 'ambiguous' : 'source-missing',
          ...(localTimestamp(task.completedAt) !== undefined ? { runEndedAt: new Date(task.completedAt!).toISOString() } : {}),
          status: { status, startedAt: task.startedAt === null ? null : new Date(task.startedAt).toISOString(),
            completedAt: isMonitorTerminal(status) && task.completedAt !== null ? new Date(task.completedAt).toISOString() : null, errorSummary: safeError(task.error) },
        })
      }
      if (recovered.length) result.push({ taskId: task.id, title: task.title, taskType, runs: recovered })
    }
    return current() ? result : []
  }
}

function safeError(value: string | null | undefined): string | null {
  if (!value) return null
  return redactText(value, Number.POSITIVE_INFINITY).slice(0, 1000)
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function localTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && Number.isFinite(new Date(value).getTime()) ? value : undefined
}
