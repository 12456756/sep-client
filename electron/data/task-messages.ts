/**
 * electron/data/task-messages.ts — 消息投影
 *
 * 本模块不持有状态、不碰文件系统，只把 run 记录和事件时间线投影成渲染进程需要的消息。
 *
 * 每个 run 产出至多两条消息：用户那一轮的提示，以及工具执行后的最终助手回复。
 * 首个 run 的提示可能没落在 run 记录里（早期数据），
 * 用任务本身的 prompt 兜底。
 */
import type { ClientTaskMessage, TaskExecutionEvent } from '../../src/shared/types'
import type { TaskRunRecord } from './task-run-store'
import { finalResponseFromEvents } from '../../src/shared/run-response'

export interface TaskMessageSources {
  listRuns(taskId: string): Promise<TaskRunRecord[]>
  getTimeline(taskId: string, runId: string): Promise<TaskExecutionEvent[]>
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
      messages.push({ id: `${run.id}-user`, role: 'user', content: prompt, createdAt: run.startedAt, runId: run.id,
        ...(run.attachmentMetadata?.length ? { attachments: structuredClone(run.attachmentMetadata) } : {}) })
    }
    const content = finalResponseFromEvents(await sources.getTimeline(taskId, run.id))
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


