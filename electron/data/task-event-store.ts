/**
 * electron/data/task-event-store.ts — 事件日志 + 内存序号分配（C6）
 *
 * 从 `task-run-store` 拆出来的第一块（方案 Phase 7）。原来那个文件捆了五件事：
 * run 记录、事件日志、消息投影、崩溃恢复、路径推导。
 *
 * C6：序号由 per-(scope, task, run) 的**内存游标**分配。原来每追加一条事件都调
 * `getTimeline()` 全量读并逐行 `JSON.parse` 整个 `events.jsonl`，只为算下一个序号
 * ——而 `text_delta` 是逐 token 产生的，一个 2000 delta 的 run 要做 2000 次全文件读取，
 * 全部串在同一条写链上，直接拖慢事件到达渲染进程的延迟。
 *
 * 事件是**追加**写，不是原子覆盖写，所以不走 `atomic-file.ts`：
 * JSONL 的容错方式是"丢掉读不出来的行"，而不是回滚整个文件。
 */
import { appendFile, mkdir, open, readFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { TaskExecutionEvent } from '../../src/shared/types'
import { redactValue } from '../common/redact'
import { ScopePath, TaskScopeError, type TaskOwnerScope } from './scope-path'
import { WriteChain } from './write-chain'

/** 首次初始化序号时最多回读的字节数。事件按 sequence 递增追加，尾部就是最大值。 */
const SEQUENCE_TAIL_BYTES = 64 * 1024

function sanitizeEvent(event: TaskExecutionEvent): TaskExecutionEvent {
  return { ...event, data: redactValue(event.data) }
}

/** 事件必须属于一个已持久化、且订阅一致的 run。校验由调用方提供。 */
export interface RunOwnershipCheck {
  (scope: TaskOwnerScope, taskId: string, runId: string): Promise<{ subscriptionId: string } | null>
}

export interface TaskEventStorePort {
  appendEvent(scope: TaskOwnerScope, event: TaskExecutionEvent): Promise<TaskExecutionEvent>
  getTimeline(scope: TaskOwnerScope, taskId: string, runId: string): Promise<TaskExecutionEvent[]>
  /** run 进入终态后丢掉它的游标，避免长驻进程里无限积累。 */
  forgetRun(scope: TaskOwnerScope, taskId: string, runId: string): void
}

export class TaskEventStore implements TaskEventStorePort {
  private readonly paths: ScopePath
  /** 同一 task 的事件写严格串行（不变式 I3 / I4）。 */
  private readonly writes = new WriteChain()
  /** C6：per-(scope, task, run) 的序号游标。 */
  private readonly sequenceCursors = new Map<string, number>()

  constructor(userDataDir: string, private readonly runBelongsToScope: RunOwnershipCheck) {
    this.paths = new ScopePath(userDataDir)
  }

  appendEvent(scope: TaskOwnerScope, event: TaskExecutionEvent): Promise<TaskExecutionEvent> {
    const eventFile = this.paths.eventFile(scope, event.taskId)
    const key = `${this.paths.scopeKey(scope)}:${event.taskId}`
    return this.writes.run(key, async () => {
      const run = await this.runBelongsToScope(scope, event.taskId, event.runId)
      if (!run || run.subscriptionId !== event.subscriptionId) {
        throw new TaskScopeError('Task event does not belong to the persisted run.')
      }
      const cursorKey = `${key}:${event.runId}`
      let cursor = this.sequenceCursors.get(cursorKey)
      if (cursor === undefined) cursor = await this.readSequenceTail(eventFile, event.taskId, event.runId)
      // 显式 sequence 只在推进游标时被采纳；比游标小的请求改判为下一个号，
      // 落盘顺序因此严格递增（不变式 I3）。生产调用方全传 0。
      const requested = Number.isInteger(event.sequence) && event.sequence > cursor ? event.sequence : cursor + 1
      this.sequenceCursors.set(cursorKey, requested)
      const persistedEvent = sanitizeEvent({ ...event, sequence: requested })
      await mkdir(dirname(eventFile), { recursive: true })
      await appendFile(eventFile, `${JSON.stringify(persistedEvent)}\n`, { encoding: 'utf8', mode: 0o600 })
      return persistedEvent
    })
  }

  async getTimeline(scope: TaskOwnerScope, taskId: string, runId: string): Promise<TaskExecutionEvent[]> {
    let contents: string
    try {
      contents = await readFile(this.paths.eventFile(scope, taskId), 'utf8')
    } catch {
      return []
    }
    const events: TaskExecutionEvent[] = []
    for (const line of contents.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line) as TaskExecutionEvent
        if (
          event && event.taskId === taskId && event.runId === runId &&
          typeof event.sequence === 'number' && typeof event.type === 'string'
        ) events.push(sanitizeEvent(event))
      } catch {
        // 忽略末尾不完整或损坏的 JSONL 行。
      }
    }
    return events.sort((a, b) => a.sequence - b.sequence)
  }

  forgetRun(scope: TaskOwnerScope, taskId: string, runId: string): void {
    this.sequenceCursors.delete(`${this.paths.scopeKey(scope)}:${taskId}:${runId}`)
  }

  /**
   * 从 events.jsonl 尾部回读，取该 run 已用的最大 sequence。只在游标缺失时走一次
   * （进程重启后续写、或崩溃恢复补事件），并且只读尾部若干字节，不整文件读。
   */
  private async readSequenceTail(eventFile: string, taskId: string, runId: string): Promise<number> {
    let handle: FileHandle
    try {
      handle = await open(eventFile, 'r')
    } catch {
      return 0
    }
    try {
      const { size } = await handle.stat()
      const length = Math.min(size, SEQUENCE_TAIL_BYTES)
      if (length === 0) return 0
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, size - length)
      // 起始处可能被截断成半行，丢掉；文件本身就比预算小时不用丢。
      const lines = buffer.toString('utf8').split('\n').slice(size > length ? 1 : 0)
      let highest = 0
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line) as TaskExecutionEvent
          if (event?.taskId === taskId && event.runId === runId && typeof event.sequence === 'number') {
            highest = Math.max(highest, event.sequence)
          }
        } catch {
          // 末尾可能是一条不完整的行，忽略。
        }
      }
      return highest
    } finally {
      await handle.close().catch(() => undefined)
    }
  }
}
