/**
 * electron/data/task-message-projector.ts — 消息投影
 *
 * 从 `task-run-store` 拆出来的第二块（方案 Phase 7）。它不持有任何状态、不碰文件系统：
 * 把 run 记录与事件时间线投影成渲染进程要的消息列表，是一段纯粹的读侧变换。
 *
 * 每个 run 产出至多两条消息：用户那一轮的提示，以及把该 run 全部 `text_delta`
 * 拼起来的助手回复。首个 run 的提示可能没落在 run 记录里（早期数据），
 * 用任务本身的 prompt 兜底。
 */
import type { ClientTaskMessage, TaskExecutionEvent } from '../../src/shared/types'
import type { TaskRunRecord } from './task-run-store'

export interface TaskMessageSources {
  listRuns(taskId: string): Promise<TaskRunRecord[]>
  getTimeline(taskId: string, runId: string): Promise<TaskExecutionEvent[]>
}

function joinTextDeltas(events: readonly TaskExecutionEvent[]): string {
  return events
    .filter(event => event.type === 'text_delta')
    .map(event => {
      const data = event.data as { text?: unknown }
      return typeof data.text === 'string' ? data.text : ''
    })
    .join('')
}

export async function projectTaskMessages(
  sources: TaskMessageSources,
  taskId: string,
  initialPrompt: string,
): Promise<ClientTaskMessage[]> {
  const runs = (await sources.listRuns(taskId)).sort((a, b) => a.startedAt - b.startedAt)
  const messages: ClientTaskMessage[] = []
  for (const [index, run] of runs.entries()) {
    const prompt = run.prompt || (index === 0 ? initialPrompt : '')
    if (prompt) {
      messages.push({ id: `${run.id}-user`, role: 'user', content: prompt, createdAt: run.startedAt, runId: run.id })
    }
    const content = joinTextDeltas(await sources.getTimeline(taskId, run.id))
    if (content) {
      messages.push({
        id: `${run.id}-assistant`,
        role: 'assistant',
        content,
        createdAt: run.endedAt ?? run.startedAt,
        runId: run.id,
      })
    }
  }
  return messages
}
