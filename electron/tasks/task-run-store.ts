import { appendFile, mkdir, readFile, rename, rm, readdir, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ClientTaskMessage, TaskExecutionEvent } from '../../src/shared/types'
import {
  TaskPersistenceError,
  TaskScopeError,
  encodeTaskScopeSegment,
  type TaskOwnerScope,
} from './task-store'

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

export interface TaskRunPaths {
  taskDir: string
  runFile: string
  sessionDir: string
  agentDir: string
}

export interface ConversationSessionPaths {
  sessionDir: string
  agentDir: string
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
  getTimeline(scope: TaskOwnerScope, taskId: string, runId: string): Promise<TaskExecutionEvent[]>
  getMessages(scope: TaskOwnerScope, taskId: string, initialPrompt: string): Promise<ClientTaskMessage[]>
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
  appendEvent(scope: TaskOwnerScope, event: TaskExecutionEvent): Promise<TaskExecutionEvent>
  getPaths(scope: TaskOwnerScope, taskId: string, runId: string): TaskRunPaths
  getConversationSessionPaths(scope: TaskOwnerScope, taskId: string): ConversationSessionPaths
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

function sanitizeError(error: string | undefined): string | null {
  if (!error) return null
  const redacted = error
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:token|password|secret|api[_-]?key)=)[^&\s]+/gi, '$1[redacted]')
  return redacted.length > 8_192 ? `${redacted.slice(0, 8_192)}...[truncated]` : redacted
}

const SENSITIVE_KEY = /authorization|cookie|password|secret|token|api[-_]?key|credential/i
function sanitizeValue(value: unknown, depth = 0, key = ''): unknown {
  if (SENSITIVE_KEY.test(key)) return '[redacted]'
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return sanitizeError(value) ?? ''
  if (!value || typeof value !== 'object' || depth >= 5) return depth >= 5 ? '[max-depth]' : undefined
  if (Array.isArray(value)) return value.slice(0, 50).map(item => sanitizeValue(item, depth + 1))
  const output: Record<string, unknown> = {}
  for (const [entryKey, entryValue] of Object.entries(value).slice(0, 50)) {
    const item = sanitizeValue(entryValue, depth + 1, entryKey)
    if (item !== undefined) output[entryKey] = item
  }
  return output
}

function sanitizeEvent(event: TaskExecutionEvent): TaskExecutionEvent {
  return { ...event, data: sanitizeValue(event.data) }
}

function assertSafeId(value: string, name: string): void {
  if (!SAFE_ID.test(value)) throw new TaskScopeError(`Invalid ${name}.`)
}

function assertContained(root: string, target: string): void {
  const normalizedRoot = resolve(root)
  const normalizedTarget = resolve(target)
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${sep}`)) {
    throw new TaskScopeError('Task run path escaped its owner scope.')
  }
}

export class TaskRunStore implements TaskRunStorePort {
  private readonly rootDir: string
  private readonly writeChains = new Map<string, Promise<void>>()

  constructor(userDataDir: string) {
    this.rootDir = join(userDataDir, 'task-data', 'v3')
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

  async get(scope: TaskOwnerScope, taskId: string, runId: string): Promise<TaskRunRecord | null> {
    const paths = this.getPaths(scope, taskId, runId)
    try {
      const record = JSON.parse(await readFile(paths.runFile, 'utf8')) as TaskRunRecord
      if (
        record.version !== 3 || record.id !== runId || record.taskId !== taskId ||
        record.owner.memberId !== scope.memberId || record.owner.enterpriseId !== scope.enterpriseId
      ) return null
      return record
    } catch {
      return null
    }
  }

  async list(scope: TaskOwnerScope, taskId: string): Promise<TaskRunRecord[]> {
    assertSafeId(taskId, 'taskId')
    const taskDir = this.getPaths(scope, taskId, 'run-list').taskDir
    const runsDir = join(taskDir, 'runs')
    let entries
    try {
      entries = await readdir(runsDir, { withFileTypes: true })
    } catch {
      return []
    }
    const records = await Promise.all(entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(async entry => {
        const runId = entry.name.slice(0, -'.json'.length)
        if (!SAFE_ID.test(runId)) return null
        return this.get(scope, taskId, runId)
      }))
    return records
      .filter((record): record is TaskRunRecord => record !== null)
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  async getTimeline(scope: TaskOwnerScope, taskId: string, runId: string): Promise<TaskExecutionEvent[]> {
    const paths = this.getPaths(scope, taskId, runId)
    const eventFile = join(paths.taskDir, 'events.jsonl')
    let contents: string
    try {
      contents = await readFile(eventFile, 'utf8')
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

  async getMessages(scope: TaskOwnerScope, taskId: string, initialPrompt: string): Promise<ClientTaskMessage[]> {
    const runs = (await this.list(scope, taskId)).sort((a, b) => a.startedAt - b.startedAt)
    const messages: ClientTaskMessage[] = []
    for (const [index, run] of runs.entries()) {
      const prompt = run.prompt || (index === 0 ? initialPrompt : '')
      if (prompt) {
        messages.push({ id: `${run.id}-user`, role: 'user', content: prompt, createdAt: run.startedAt, runId: run.id })
      }
      const events = await this.getTimeline(scope, taskId, run.id)
      const content = events
        .filter(event => event.type === 'text_delta')
        .map(event => {
          const data = event.data as { text?: unknown }
          return typeof data.text === 'string' ? data.text : ''
        })
        .join('')
      if (content) {
        messages.push({ id: `${run.id}-assistant`, role: 'assistant', content, createdAt: run.endedAt ?? run.startedAt, runId: run.id })
      }
    }
    return messages
  }

  async markActiveRunsInterrupted(scope: TaskOwnerScope): Promise<number> {
    const ownerRoot = join(this.rootDir, encodeTaskScopeSegment(scope.enterpriseId, 'enterpriseId'), encodeTaskScopeSegment(scope.memberId, 'memberId'))
    const tasksRoot = join(ownerRoot, 'tasks')
    let taskEntries
    try {
      taskEntries = await readdir(tasksRoot, { withFileTypes: true })
    } catch {
      return 0
    }
    let changed = 0
    for (const taskEntry of taskEntries) {
      if (!taskEntry.isDirectory() || !SAFE_ID.test(taskEntry.name)) continue
      const taskId = taskEntry.name
      const runsDir = join(tasksRoot, taskId, 'runs')
      let runEntries
      try {
        runEntries = await readdir(runsDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const runEntry of runEntries) {
        if (!runEntry.isFile() || !runEntry.name.endsWith('.json')) continue
        const runId = runEntry.name.slice(0, -'.json'.length)
        if (!SAFE_ID.test(runId)) continue
        const record = await this.get(scope, taskId, runId)
        if (!record || record.outcome !== 'running') continue
        const timeline = await this.getTimeline(scope, taskId, runId)
        const completedToolIds = new Set(timeline
          .filter(event => event.type === 'tool_execution_end')
          .map(event => (event.data as { toolId?: unknown }).toolId)
          .filter((toolId): toolId is string => typeof toolId === 'string'))
        for (const event of timeline) {
          if (event.type !== 'tool_execution_start') continue
          const data = event.data as { toolId?: unknown; toolName?: unknown }
          if (
            typeof data.toolId !== 'string' || completedToolIds.has(data.toolId) ||
            typeof data.toolName !== 'string' || !['bash', 'write', 'edit'].includes(data.toolName)
          ) continue
          await this.appendEvent(scope, {
            taskId,
            runId,
            subscriptionId: record.subscriptionId,
            sequence: 0,
            type: 'SIDE_EFFECT_UNKNOWN',
            occurredAt: Date.now(),
            data: { toolId: data.toolId, toolName: data.toolName, startedAt: event.occurredAt, replayAllowed: false },
          })
        }
        await this.finish(scope, taskId, runId, 'interrupted', 'Application stopped before the run completed.')
        changed++
      }
    }
    return changed
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

  async finish(
    scope: TaskOwnerScope,
    taskId: string,
    runId: string,
    outcome: TaskRunOutcome,
    error?: string,
  ): Promise<boolean> {
    return this.transition(scope, taskId, runId, ['running'], outcome, error)
  }

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
        error: sanitizeError(error),
      }
    })
    return changed
  }

  appendEvent(scope: TaskOwnerScope, event: TaskExecutionEvent): Promise<TaskExecutionEvent> {
    const paths = this.getPaths(scope, event.taskId, event.runId)
    const eventFile = join(paths.taskDir, 'events.jsonl')
    const key = `${scope.enterpriseId}:${scope.memberId}:${event.taskId}`
    return this.enqueueValue(key, async () => {
      const run = await this.get(scope, event.taskId, event.runId)
      if (!run || run.subscriptionId !== event.subscriptionId) {
        throw new TaskScopeError('Task event does not belong to the persisted run.')
      }
      const timeline = await this.getTimeline(scope, event.taskId, event.runId)
      const usedSequences = new Set(timeline.map(item => item.sequence))
      const nextSequence = (timeline.at(-1)?.sequence ?? 0) + 1
      const requestedSequence = Number.isInteger(event.sequence) && event.sequence > 0 ? event.sequence : nextSequence
      const persistedEvent = sanitizeEvent({
        ...event,
        sequence: usedSequences.has(requestedSequence) ? nextSequence : requestedSequence,
      })
      await mkdir(paths.taskDir, { recursive: true })
      await appendFile(eventFile, `${JSON.stringify(persistedEvent)}\n`, { encoding: 'utf8', mode: 0o600 })
      return persistedEvent
    })
  }

  getPaths(scope: TaskOwnerScope, taskId: string, runId: string): TaskRunPaths {
    assertSafeId(taskId, 'taskId')
    assertSafeId(runId, 'runId')
    const enterprise = encodeTaskScopeSegment(scope.enterpriseId, 'enterpriseId')
    const member = encodeTaskScopeSegment(scope.memberId, 'memberId')
    const ownerRoot = join(this.rootDir, enterprise, member)
    const taskDir = join(ownerRoot, 'tasks', taskId)
    const paths = {
      taskDir,
      runFile: join(taskDir, 'runs', `${runId}.json`),
      sessionDir: join(taskDir, 'sessions', runId),
      agentDir: join(taskDir, 'agent-runs', runId),
    }
    for (const path of Object.values(paths)) assertContained(ownerRoot, path)
    return paths
  }

  getConversationSessionPaths(scope: TaskOwnerScope, taskId: string): ConversationSessionPaths {
    const taskDir = this.getPaths(scope, taskId, 'conversation-session').taskDir
    const enterprise = encodeTaskScopeSegment(scope.enterpriseId, 'enterpriseId')
    const member = encodeTaskScopeSegment(scope.memberId, 'memberId')
    const ownerRoot = join(this.rootDir, enterprise, member)
    const paths = {
      sessionDir: join(taskDir, 'conversation', 'pi-session'),
      agentDir: join(taskDir, 'conversation', 'pi-agent'),
    }
    for (const path of Object.values(paths)) assertContained(ownerRoot, path)
    return paths
  }

  private async mutate(
    scope: TaskOwnerScope,
    taskId: string,
    runId: string,
    update: (record: TaskRunRecord) => TaskRunRecord,
  ): Promise<void> {
    const paths = this.getPaths(scope, taskId, runId)
    const key = `${scope.enterpriseId}:${scope.memberId}:${taskId}`
    await this.enqueue(key, async () => {
      let record: TaskRunRecord
      try {
        record = JSON.parse(await readFile(paths.runFile, 'utf8')) as TaskRunRecord
      } catch (error) {
        throw new TaskPersistenceError(error instanceof Error ? error.message : undefined)
      }
      if (
        record.version !== 3 ||
        record.id !== runId ||
        record.taskId !== taskId ||
        record.owner.memberId !== scope.memberId ||
        record.owner.enterpriseId !== scope.enterpriseId
      ) {
        throw new TaskScopeError('Task run does not belong to the active user.')
      }
      await this.writeRecord(paths.runFile, update(record))
    })
  }

  private enqueue(key: string, operation: () => Promise<void>): Promise<void> {
    const prior = this.writeChains.get(key) ?? Promise.resolve()
    const next = prior.catch(() => undefined).then(operation)
    this.writeChains.set(key, next)
    return next.finally(() => {
      if (this.writeChains.get(key) === next) this.writeChains.delete(key)
    })
  }

  private enqueueValue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.writeChains.get(key) ?? Promise.resolve()
    const result = prior.catch(() => undefined).then(operation)
    const tracked = result.then(() => undefined)
    this.writeChains.set(key, tracked)
    return result.finally(() => {
      if (this.writeChains.get(key) === tracked) this.writeChains.delete(key)
    })
  }

  private async writeRecord(file: string, record: TaskRunRecord): Promise<void> {
    const temporaryFile = `${file}.${randomUUID()}.tmp`
    try {
      await mkdir(join(file, '..'), { recursive: true })
      await writeFile(temporaryFile, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 })
      await rename(temporaryFile, file)
    } catch (error) {
      await rm(temporaryFile, { force: true }).catch(() => undefined)
      throw new TaskPersistenceError(error instanceof Error ? error.message : undefined)
    }
  }
}
