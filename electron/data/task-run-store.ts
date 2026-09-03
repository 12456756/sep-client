/**
 * electron/data/task-run-store.ts — run 记录
 *
 * Phase 7 之前这个文件捆了五件事（方案 1.3 节）：run 记录、事件日志、消息投影、
 * 崩溃恢复、路径推导。现在事件在 `task-event-store.ts`、投影在
 * `task-message-projector.ts`、路径在 `scope-path.ts`、原子写在 `atomic-file.ts`。
 *
 * 这里留下的是 run 记录本身，加上崩溃恢复——后者必须同时读 run 记录与事件，
 * 所以本类拥有一个 `TaskEventStore` 实例并以 `events` 暴露；事件的逻辑一行都不在这里。
 */
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { TaskExecutionEvent } from '../../src/shared/types'
import { hasSideEffects } from '../common/constants'
import { redactOptionalText } from '../common/redact'
import { readJsonFile, writeJsonAtomic } from './atomic-file'
import { ScopePath, TaskScopeError, isSafeId, type ConversationSessionPaths, type TaskOwnerScope, type TaskRunPaths } from './scope-path'
import { TaskEventStore, type TaskEventStorePort } from './task-event-store'
import { WriteChain } from './write-chain'
import { TaskPersistenceError } from './task-store'

export type { ConversationSessionPaths, TaskRunPaths } from './scope-path'

export type TaskRunOutcome =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'stopped'
  | 'interrupted'

export interface TaskRunRecord {
  version: 3
  id: string
  taskId: string
  owner: TaskOwnerScope
  subscriptionId: string
  modelId: string
  runtimeKey: string
  workspaceDir: string
  sessionDir: string
  agentDir: string
  sessionId: string | null
  sessionFile: string | null
  startedAt: number
  endedAt: number | null
  outcome: TaskRunOutcome
  error: string | null
  prompt?: string
}

export interface CreateTaskRunInput {
  taskId: string
  runId: string
  subscriptionId: string
  modelId: string
  runtimeKey: string
  workspaceDir: string
  prompt: string
}

export interface TaskRunStorePort {
  create(scope: TaskOwnerScope, input: CreateTaskRunInput): Promise<TaskRunRecord>
  get(scope: TaskOwnerScope, taskId: string, runId: string): Promise<TaskRunRecord | null>
  list(scope: TaskOwnerScope, taskId: string): Promise<TaskRunRecord[]>
  markActiveRunsInterrupted(scope: TaskOwnerScope): Promise<number>
  setSession(scope: TaskOwnerScope, taskId: string, runId: string, session: {
    sessionId: string
    sessionFile: string | null
  }): Promise<void>
  transition(
    scope: TaskOwnerScope,
    taskId: string,
    runId: string,
    expected: readonly TaskRunOutcome[],
    outcome: TaskRunOutcome,
    error?: string,
  ): Promise<boolean>
  finish(scope: TaskOwnerScope, taskId: string, runId: string, outcome: TaskRunOutcome, error?: string): Promise<boolean>
  getPaths(scope: TaskOwnerScope, taskId: string, runId: string): TaskRunPaths
  getTaskDir(scope: TaskOwnerScope, taskId: string): string
  getConversationSessionPaths(scope: TaskOwnerScope, taskId: string): ConversationSessionPaths
  readonly events: TaskEventStorePort
}

export class TaskRunStore implements TaskRunStorePort {
  private readonly paths: ScopePath
  /** 同一 task 的 run 记录写严格串行。 */
  private readonly writes = new WriteChain()
  readonly events: TaskEventStore

  constructor(userDataDir: string) {
    this.paths = new ScopePath(userDataDir)
    // 事件必须属于一个已持久化、订阅一致的 run，这个判断只有 run 记录知道。
    this.events = new TaskEventStore(userDataDir, (scope, taskId, runId) => this.get(scope, taskId, runId))
  }

  async create(scope: TaskOwnerScope, input: CreateTaskRunInput): Promise<TaskRunRecord> {
    const paths = this.getPaths(scope, input.taskId, input.runId)
    const record: TaskRunRecord = {
      version: 3,
      id: input.runId,
      taskId: input.taskId,
      owner: { ...scope },
      subscriptionId: input.subscriptionId,
      modelId: input.modelId,
      runtimeKey: input.runtimeKey,
      workspaceDir: input.workspaceDir,
      sessionDir: paths.sessionDir,
      agentDir: paths.agentDir,
      sessionId: null,
      sessionFile: null,
      startedAt: Date.now(),
      endedAt: null,
      outcome: 'running',
      error: null,
      prompt: input.prompt,
    }
    await Promise.all([
      mkdir(join(paths.taskDir, 'runs'), { recursive: true }),
      mkdir(paths.sessionDir, { recursive: true }),
      mkdir(paths.agentDir, { recursive: true }),
    ])
    await this.writeRecord(paths.runFile, record)
    return record
  }

  /** 读不出来、或不属于这个 scope，一律当不存在。 */
  async get(scope: TaskOwnerScope, taskId: string, runId: string): Promise<TaskRunRecord | null> {
    const record = await readJsonFile(this.getPaths(scope, taskId, runId).runFile) as TaskRunRecord | null
    return this.belongsTo(record, scope, taskId, runId) ? record : null
  }

  async list(scope: TaskOwnerScope, taskId: string): Promise<TaskRunRecord[]> {
    const records = await Promise.all(
      (await this.listRunIds(scope, taskId)).map(runId => this.get(scope, taskId, runId)),
    )
    return records
      .filter((record): record is TaskRunRecord => record !== null)
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  async setSession(
    scope: TaskOwnerScope,
    taskId: string,
    runId: string,
    session: { sessionId: string; sessionFile: string | null },
  ): Promise<void> {
    await this.mutate(scope, taskId, runId, record => ({
      ...record,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
    }))
  }

  finish(
    scope: TaskOwnerScope,
    taskId: string,
    runId: string,
    outcome: TaskRunOutcome,
    error?: string,
  ): Promise<boolean> {
    return this.transition(scope, taskId, runId, ['running'], outcome, error)
  }

  /** 终态只写一次（不变式 I9）：`expected` 不匹配就什么都不改。 */
  async transition(
    scope: TaskOwnerScope,
    taskId: string,
    runId: string,
    expected: readonly TaskRunOutcome[],
    outcome: TaskRunOutcome,
    error?: string,
  ): Promise<boolean> {
    let changed = false
    await this.mutate(scope, taskId, runId, record => {
      if (!expected.includes(record.outcome)) return record
      changed = true
      return {
        ...record,
        outcome,
        endedAt: outcome === 'running' ? null : Date.now(),
        error: redactOptionalText(error),
      }
    })
    // run 进入终态后不会再有事件，游标可以丢掉。
    if (changed && outcome !== 'running') this.events.forgetRun(scope, taskId, runId)
    return changed
  }

  /**
   * 崩溃恢复：上次启动留下的 `running` run 一律结算为 interrupted，
   * 并为每个"开始了但没收到 tool_execution_end"的副作用工具补一条
   * `SIDE_EFFECT_UNKNOWN`——否则下次启动无法判定副作用是否已发生（C3 / 不变式 I7）。
   */
  async markActiveRunsInterrupted(scope: TaskOwnerScope): Promise<number> {
    const tasksRoot = this.paths.tasksRoot(scope)
    let taskEntries
    try {
      taskEntries = await readdir(tasksRoot, { withFileTypes: true })
    } catch {
      return 0
    }
    let changed = 0
    for (const taskEntry of taskEntries) {
      if (!taskEntry.isDirectory() || !isSafeId(taskEntry.name)) continue
      const taskId = taskEntry.name
      for (const runId of await this.listRunIds(scope, taskId)) {
        const record = await this.get(scope, taskId, runId)
        if (!record || record.outcome !== 'running') continue
        for (const pending of pendingSideEffects(await this.events.getTimeline(scope, taskId, runId))) {
          await this.events.appendEvent(scope, {
            taskId,
            runId,
            subscriptionId: record.subscriptionId,
            sequence: 0,
            type: 'SIDE_EFFECT_UNKNOWN',
            occurredAt: Date.now(),
            data: { ...pending, replayAllowed: false },
          })
        }
        await this.finish(scope, taskId, runId, 'interrupted', 'Application stopped before the run completed.')
        changed++
      }
    }
    return changed
  }

  // ── 路径（全部委托给 scope-path.ts）─────────────────────────────────────────

  getPaths(scope: TaskOwnerScope, taskId: string, runId: string): TaskRunPaths {
    return this.paths.runPaths(scope, taskId, runId)
  }

  /** 任务目录。原来要借位一个假 runId 才拿得到（`getPaths(scope, taskId, 'store')`）。 */
  getTaskDir(scope: TaskOwnerScope, taskId: string): string {
    return this.paths.taskDir(scope, taskId)
  }

  getConversationSessionPaths(scope: TaskOwnerScope, taskId: string): ConversationSessionPaths {
    return this.paths.conversationSessionPaths(scope, taskId)
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────

  private async listRunIds(scope: TaskOwnerScope, taskId: string): Promise<string[]> {
    let entries
    try {
      entries = await readdir(this.paths.runsDir(scope, taskId), { withFileTypes: true })
    } catch {
      return []
    }
    return entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => entry.name.slice(0, -'.json'.length))
      // `.bak` 不以 .json 结尾，隔离文件的 runId 段含点号——两者都过不了这一关。
      .filter(isSafeId)
  }

  private belongsTo(
    record: TaskRunRecord | null,
    scope: TaskOwnerScope,
    taskId: string,
    runId: string,
  ): boolean {
    return Boolean(
      record &&
      record.version === 3 &&
      record.id === runId &&
      record.taskId === taskId &&
      record.owner?.memberId === scope.memberId &&
      record.owner?.enterpriseId === scope.enterpriseId,
    )
  }

  private async mutate(
    scope: TaskOwnerScope,
    taskId: string,
    runId: string,
    update: (record: TaskRunRecord) => TaskRunRecord,
  ): Promise<void> {
    const runFile = this.getPaths(scope, taskId, runId).runFile
    const key = `${this.paths.scopeKey(scope)}:${taskId}`
    await this.writes.run(key, async () => {
      const record = await readJsonFile(runFile) as TaskRunRecord | null
      if (!record) throw new TaskPersistenceError('Task run record could not be read.')
      if (!this.belongsTo(record, scope, taskId, runId)) {
        throw new TaskScopeError('Task run does not belong to the active user.')
      }
      await this.writeRecord(runFile, update(record))
    })
  }

  private async writeRecord(file: string, record: TaskRunRecord): Promise<void> {
    try {
      await writeJsonAtomic(file, record)
    } catch (error) {
      throw new TaskPersistenceError(error instanceof Error ? error.message : undefined)
    }
  }
}

/** 开始了但没收到 `tool_execution_end` 的副作用工具调用。 */
function pendingSideEffects(
  timeline: readonly TaskExecutionEvent[],
): { toolId: string; toolName: string; startedAt: number }[] {
  const completed = new Set(timeline
    .filter(event => event.type === 'tool_execution_end')
    .map(event => (event.data as { toolId?: unknown }).toolId)
    .filter((toolId): toolId is string => typeof toolId === 'string'))

  const pending: { toolId: string; toolName: string; startedAt: number }[] = []
  for (const event of timeline) {
    if (event.type !== 'tool_execution_start') continue
    const data = event.data as { toolId?: unknown; toolName?: unknown }
    if (
      typeof data.toolId !== 'string' || completed.has(data.toolId) ||
      typeof data.toolName !== 'string' || !hasSideEffects(data.toolName)
    ) continue
    pending.push({ toolId: data.toolId, toolName: data.toolName, startedAt: event.occurredAt })
  }
  return pending
}
