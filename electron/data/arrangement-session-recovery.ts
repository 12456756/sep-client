import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { hasSideEffects } from '../common/constants'
import type { ArrangementNode } from '../domain/arrangement-plan'
import type { ArrangementNodeCheckpoint } from '../domain/arrangement-execution'
import type { TaskOwnerScope } from './scope-path'
import type { TaskRunRecord, TaskRunStorePort } from './task-run-store'

export interface ArrangementSessionRecovery {
  runId: string
  sessionFile: string
}

/** Recover only this node's canonical Pi history, including pre-migration runs. */
export async function recoverArrangementSession(
  store: TaskRunStorePort, scope: TaskOwnerScope, taskId: string,
  node: ArrangementNode, checkpoint: ArrangementNodeCheckpoint, workspaceDir: string,
): Promise<ArrangementSessionRecovery | null> {
  let previous: TaskRunRecord | null = null
  if (checkpoint.sessionRunId) {
    previous = await store.get(scope, taskId, checkpoint.sessionRunId)
    if (!previous?.sessionFile || !previous.sessionId) throw new Error('失败节点的历史会话记录丢失，无法继续已有上下文。')
  } else if (checkpoint.attempt > 1) {
    const runs = await store.list(scope, taskId)
    const candidates = new Map<string, TaskRunRecord>()
    for (const run of runs) {
      if (run.arrangementNodeId === node.id) candidates.set(run.id, run)
      const events = await store.events.getTimeline(scope, taskId, run.id)
      for (const event of events) {
        if (!event.type.startsWith('arrangement_node_')) continue
        const data = event.data as { nodeId?: unknown; nodeRunId?: unknown } | null
        if (data?.nodeId !== node.id || typeof data.nodeRunId !== 'string') continue
        const record = await store.get(scope, taskId, data.nodeRunId)
        if (!record) {
          // Authorization/setup may fail before a run or a session is created.
          if (event.type === 'arrangement_node_failed' && !(event.data as { startedAt?: unknown }).startedAt) continue
          throw new Error('失败节点的历史运行记录丢失，无法定位已有会话。')
        }
        candidates.set(record.id, record)
      }
    }
    previous = [...candidates.values()].filter(run => run.sessionId || run.sessionFile)
      .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null
    if (!previous) return null // Previous setup never created a conversation.
    if (!previous.sessionFile || !previous.sessionId) throw new Error('失败节点的历史会话记录不完整，无法继续已有上下文。')
  } else return null

  if (previous.subscriptionId !== node.subscriptionId || previous.modelId !== node.modelId ||
      (previous.arrangementNodeId && previous.arrangementNodeId !== node.id) ||
      resolve(previous.workspaceDir) !== resolve(workspaceDir)) {
    throw new Error('失败节点的历史会话与当前节点或工作目录不一致，无法恢复。')
  }
  const sessionFile = previous.sessionFile!
  try {
    const taskRoot = await realpath(store.getTaskDir(scope, taskId))
    const actual = await realpath(sessionFile)
    const inside = relative(taskRoot, actual)
    if (!inside || inside === '..' || inside.startsWith('..'+sep) || isAbsolute(inside)) throw new Error('outside task')
    const entries: Array<Record<string, unknown>> = (await readFile(actual, 'utf8')).split(/\r?\n/)
      .filter(line => line.trim()).map(line => {
        const entry: unknown = JSON.parse(line)
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('invalid entry')
        return entry as Record<string, unknown>
      })
    if (entries[0]?.type !== 'session' || entries[0]?.id !== previous.sessionId) throw new Error('invalid session header')
    // A completed side effect must also have its canonical tool result persisted.
    const ids = new Set<string>()
    for (const entry of entries.slice(1)) {
      if ((entry.parentId !== null && (typeof entry.parentId !== 'string' || !ids.has(entry.parentId))) ||
          typeof entry.id !== 'string' || ids.has(entry.id)) throw new Error('broken session chain')
      ids.add(entry.id)
      if (typeof entry.type !== 'string' || typeof entry.id !== 'string') throw new Error('invalid session entry')
      if (entry.type === 'message') {
        const message = entry.message as { role?: unknown; content?: unknown } | undefined
        if (!message || typeof message.role !== 'string' ||
          !(typeof message.content === 'string' || Array.isArray(message.content))) throw new Error('invalid message')
      }
    }
    const results = new Set(entries.filter(entry => entry.type === 'message').map(entry => {
      const message = entry.message as { role?: unknown; toolCallId?: unknown } | undefined
      return message?.role === 'toolResult' ? message.toolCallId : undefined
    }))
    const timeline = await store.events.getTimeline(scope, taskId, previous.id)
    if (timeline.some(event => {
      const data = event.data as { toolId?: unknown; toolName?: unknown } | null
      return (event.type === 'tool_execution_start' || event.type === 'SIDE_EFFECT_UNKNOWN') &&
        typeof data?.toolName === 'string' && hasSideEffects(data.toolName) && !results.has(data.toolId)
    })) throw new Error('SIDE_EFFECT_UNKNOWN')
  } catch (error) {
    if (error instanceof Error && error.message === 'SIDE_EFFECT_UNKNOWN') {
      throw new Error('中断时有工具操作未保存执行结果，请先核实该操作，避免重试时重复写入或提交。')
    }
    throw new Error('失败节点的历史会话文件丢失、损坏或不属于当前任务，无法继续已有上下文。')
  }
  return { runId: previous.id, sessionFile }
}
