import type { TaskExecutionEvent } from './types'
export type WorkActivityState = 'running' | 'completed' | 'failed' | 'waiting-user'

export interface WorkActivity {
  id: string
  runId: string
  toolName?: string
  text: string
  state: WorkActivityState
  startedAt: number
  endedAt?: number
}

const MAX_ACTIVITY_COUNT = 80
const MAX_ERROR_LENGTH = 120

export function runtimeKey(taskId: string, runId: string): string {
  return `${taskId}:${runId}`
}

export function activityLabel(toolName: string | undefined): string {
  switch (toolName) {
    case 'write': return '文件写入'
    case 'edit': return '文件编辑'
    case 'bash': return '命令执行'
    case 'read': return '资料读取'
    default: return '工具操作'
  }
}

export function applyRuntimeEvent(current: WorkActivity[], event: TaskExecutionEvent): WorkActivity[] {
  const data = asRecord(event.data)
  const at = Number.isFinite(event.occurredAt) ? event.occurredAt : Date.now()
  const toolName = stringValue(data.toolName)
  const toolId = stringValue(data.toolId)
  const nodeId = stringValue(data.nodeId)
  const nodeRunId = stringValue(data.nodeRunId)
  const activityId = toolId ? `tool:${toolId}` : nodeRunId ? `node:${nodeRunId}` : `event:${event.sequence}`

  if (event.type === 'tool_execution_start') {
    return append(current, {
      id: activityId,
      runId: event.runId,
      toolName,
      text: `正在执行${activityLabel(toolName)}`,
      state: 'running',
      startedAt: at,
    })
  }

  if (event.type === 'tool_execution_end') {
    return updateById(current, activityId, activity => ({
      ...activity,
      text: stringValue(data.success) === 'false' || data.success === false ? `${activityLabel(toolName ?? activity.toolName)}未完成` : `已完成${activityLabel(toolName ?? activity.toolName)}`,
      state: data.success === false ? 'failed' : 'completed',
      endedAt: at,
    }))
  }

  if (event.type === 'approval_requested') {
    const requestId = stringValue(data.requestId) ?? activityId
    return append(current, {
      id: `approval:${requestId}`,
      runId: event.runId,
      toolName,
      text: `等待你的确认：${activityLabel(toolName)}`,
      state: 'waiting-user',
      startedAt: at,
    })
  }

  if (event.type === 'approval_resolved') {
    const requestId = stringValue(data.requestId)
    const existing = current.find(activity => activity.id === `approval:${requestId}`)
    if (!existing) return current
    const approved = data.approved === true
    return updateById(current, existing.id, activity => ({
      ...activity,
      text: approved ? '已获得确认' : '未获得确认，操作已被阻止',
      state: approved ? 'completed' : 'failed',
      endedAt: at,
    }))
  }

  if (event.type === 'workflow_node_started') {
    return append(current, {
      id: activityId,
      runId: event.runId,
      text: `开始执行：${safeLabel(stringValue(data.title) ?? nodeId ?? '当前步骤')}`,
      state: 'running',
      startedAt: at,
    })
  }

  if (event.type === 'workflow_node_completed' || event.type === 'workflow_node_failed') {
    const state: WorkActivityState = event.type === 'workflow_node_failed' ? 'failed' : 'completed'
    return updateById(current, activityId, activity => ({
      ...activity,
      text: event.type === 'workflow_node_failed'
        ? '当前步骤执行失败'
        : `已完成：${safeLabel(stringValue(data.title) ?? nodeId ?? '当前步骤')}`,
      state,
      endedAt: at,
    }))
  }

  if (event.type === 'workflow_state_changed') {
    return append(current, {
      id: activityId,
      runId: event.runId,
      text: '工作流程状态已更新',
      state: 'running',
      startedAt: at,
    })
  }

  if (event.type === 'tool_call_blocked' || event.type === 'unknown_tool_blocked') {
    return append(current, {
      id: activityId,
      runId: event.runId,
      toolName,
      text: `操作已被阻止：${activityLabel(toolName)}`,
      state: 'failed',
      startedAt: at,
      endedAt: at,
    })
  }

  if (event.type === 'SIDE_EFFECT_UNKNOWN') {
    return append(current, {
      id: activityId,
      runId: event.runId,
      toolName,
      text: '操作结果暂时无法确认，请检查工作记录',
      state: 'failed',
      startedAt: at,
      endedAt: at,
    })
  }

  if (event.type === 'auto_retry_start') {
    return append(current, { id: activityId, runId: event.runId, text: '正在自动重试', state: 'running', startedAt: at })
  }

  if (event.type === 'auto_retry_end') {
    return updateById(current, activityId, activity => ({
      ...activity,
      text: data.success === true ? '自动重试完成' : '自动重试未成功',
      state: data.success === true ? 'completed' : 'failed',
      endedAt: at,
    }))
  }

  if (event.type === 'session_error') {
    return append(current, {
      id: activityId,
      runId: event.runId,
      text: `运行遇到问题：${safeError(stringValue(data.message))}`,
      state: 'failed',
      startedAt: at,
      endedAt: at,
    })
  }

  return current
}

function append(current: WorkActivity[], activity: WorkActivity): WorkActivity[] {
  const withoutSameId = current.filter(item => item.id !== activity.id)
  return [...withoutSameId, activity].slice(-MAX_ACTIVITY_COUNT)
}

function updateById(current: WorkActivity[], id: string, update: (activity: WorkActivity) => WorkActivity): WorkActivity[] {
  const index = current.findIndex(activity => activity.id === id)
  if (index < 0) return current
  return current.map((activity, currentIndex) => currentIndex === index ? update(activity) : activity)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function safeLabel(value: string): string {
  return value.replace(/[\\r\\n]+/g, ' ').slice(0, MAX_ERROR_LENGTH)
}

function safeError(value: string | undefined): string {
  return value ? safeLabel(value) : '请查看工作记录'
}
