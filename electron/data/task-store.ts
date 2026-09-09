/**
 * electron/data/task-store.ts — 任务快照的读写
 *
 * 原子写与 `.bak` / 隔离语义在 `atomic-file.ts`，路径推导在 `scope-path.ts`。
 * 这里只剩两件事：快照的**校验**（跨 scope 的条目一律丢掉）与 scope 级写串行化。
 */
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { TaskStatus, type ClientTask, type ClientTaskLog } from '../../src/shared/types'
import { describeError } from '../common/redact'
import { logger } from '../common/logger'
import { pathExists, readJsonWithBackup, writeJsonAtomic } from './atomic-file'
import { ScopePath, type TaskOwnerScope } from './scope-path'
import { WriteChain } from './write-chain'

const log = logger.child('task-store')

export class TaskPersistenceError extends Error {
  constructor(message = 'Task history could not be persisted.') {
    super(message)
    this.name = 'TaskPersistenceError'
  }
}

interface PersistedTaskStore {
  version: 3
  owner: TaskOwnerScope
  updatedAt: number
  tasks: ClientTask[]
}

function isTaskStatus(value: unknown): value is ClientTask['status'] {
  return Object.values(TaskStatus).includes(value as ClientTask['status'])
}

function parseTask(value: unknown): ClientTask | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<ClientTask>
  if (
    typeof item.id !== 'string' ||
    item.id.length === 0 ||
    typeof item.title !== 'string' ||
    typeof item.prompt !== 'string' ||
    !isTaskStatus(item.status) ||
    (typeof item.workDir !== 'string' && item.workDir !== null) ||
    typeof item.createdAt !== 'number' ||
    !Number.isFinite(item.createdAt) ||
    (typeof item.startedAt !== 'number' && item.startedAt !== null) ||
    (typeof item.completedAt !== 'number' && item.completedAt !== null) ||
    (typeof item.error !== 'string' && item.error !== null) ||
    !Array.isArray(item.files) ||
    !Array.isArray(item.logs) ||
    typeof item.ownerId !== 'string' ||
    typeof item.ownerEnterpriseId !== 'string'
  ) {
    return null
  }

  const logs = item.logs.filter((log): log is ClientTaskLog => {
    if (!log || typeof log !== 'object') return false
    const entry = log as Partial<ClientTaskLog>
    return (
      typeof entry.timestamp === 'number' &&
      Number.isFinite(entry.timestamp) &&
      typeof entry.message === 'string' &&
      (entry.level === undefined || entry.level === 'info' || entry.level === 'warning' || entry.level === 'error')
    )
  })

  return {
    id: item.id,
    title: item.title,
    prompt: item.prompt,
    status: item.status,
    workDir: item.workDir,
    createdAt: item.createdAt,
    startedAt: item.startedAt,
    completedAt: item.completedAt,
    error: item.error,
    files: item.files.filter((file): file is string => typeof file === 'string'),
    logs,
    progress: typeof item.progress === 'number' && Number.isFinite(item.progress)
      ? Math.max(0, Math.min(100, item.progress))
      : undefined,
    ownerId: item.ownerId,
    ownerEnterpriseId: item.ownerEnterpriseId,
    subscriptionId: typeof item.subscriptionId === 'string' ? item.subscriptionId : null,
    activeRunId: typeof item.activeRunId === 'string' ? item.activeRunId : null,
  }
}

function parseEnvelope(value: unknown, scope: TaskOwnerScope): ClientTask[] | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<PersistedTaskStore>
  if (
    item.version !== 3 ||
    !item.owner ||
    item.owner.memberId !== scope.memberId ||
    item.owner.enterpriseId !== scope.enterpriseId ||
    !Array.isArray(item.tasks)
  ) {
    return null
  }

  const seen = new Set<string>()
  const tasks: ClientTask[] = []
  for (const value of item.tasks) {
    const task = parseTask(value)
    if (!task || task.ownerId !== scope.memberId || task.ownerEnterpriseId !== scope.enterpriseId) continue
    if (seen.has(task.id)) continue
    seen.add(task.id)
    tasks.push(task)
  }
  return tasks
}

export interface TaskStorePort {
  initialize(): Promise<void>
  load(scope: TaskOwnerScope): Promise<ClientTask[]>
  save(scope: TaskOwnerScope, tasks: ClientTask[]): Promise<void>
}


export class TaskStore implements TaskStorePort {
  private readonly paths: ScopePath
  private readonly legacyRootDir: string
  private initialized = false
  private initialization: Promise<void> | null = null
  /** 同一 scope 的快照写严格串行（不变式 I5）。 */
  private readonly writes = new WriteChain()

  constructor(private readonly userDataDir: string) {
    this.paths = new ScopePath(userDataDir)
    this.legacyRootDir = join(userDataDir, 'task-data', 'v2')
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    if (!this.initialization) {
      this.initialization = (async () => {
        await mkdir(this.paths.dataRoot(), { recursive: true })
        await this.removeLegacyStore()
        this.initialized = true
      })()
    }
    await this.initialization
  }

  /** 读不出来就当空快照：`.bak` 回退与损坏隔离都在 atomic-file 里。 */
  async load(scope: TaskOwnerScope): Promise<ClientTask[]> {
    this.ensureInitialized()
    const tasks = await readJsonWithBackup(
      this.paths.taskSnapshotFile(scope),
      value => parseEnvelope(value, scope),
    )
    return tasks ?? []
  }

  /** 同一 scope 的写严格串行（不变式 I5）。前一个失败不影响后一个排队。 */
  save(scope: TaskOwnerScope, tasks: ClientTask[]): Promise<void> {
    this.ensureInitialized()
    return this.writes.run(this.paths.scopeKey(scope), () => this.writeSnapshot(scope, tasks))
  }

  getTaskFileForTesting(scope: TaskOwnerScope): string {
    return this.paths.taskSnapshotFile(scope)
  }

  private async writeSnapshot(scope: TaskOwnerScope, tasks: ClientTask[]): Promise<void> {
    const envelope: PersistedTaskStore = {
      version: 3,
      owner: { ...scope },
      updatedAt: Date.now(),
      tasks: tasks.map(task => ({ ...task, files: [...task.files], logs: task.logs.map(log => ({ ...log })) })),
    }
    try {
      await writeJsonAtomic(this.paths.taskSnapshotFile(scope), envelope)
    } catch (error) {
      throw new TaskPersistenceError(error instanceof Error ? error.message : undefined)
    }
  }

  private ensureInitialized(): void {
    if (!this.initialized) throw new TaskPersistenceError('Task store is not initialized.')
  }

  /** v2 与更早的单文件历史一律删掉，不迁移——它们的 scope 语义与 v3 不同。 */
  private async removeLegacyStore(): Promise<void> {
    const legacyFile = join(this.userDataDir, 'tasks.json')
    if (await pathExists(this.legacyRootDir)) {
      try {
        await rm(this.legacyRootDir, { recursive: true, force: true })
      } catch (error) {
        throw new TaskPersistenceError(error instanceof Error ? error.message : 'Failed to remove v2 task data.')
      }
    }
    if (!await pathExists(legacyFile)) return
    try {
      await rm(legacyFile, { force: true })
    } catch (error) {
      log.warn('failed to remove deprecated task history', { cause: describeError(error) })
    }
  }
}
