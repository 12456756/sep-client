import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { TaskStatus, type ClientTask, type ClientTaskLog } from '../../src/shared/types'

export interface TaskOwnerScope {
  memberId: string
  enterpriseId: string
}

export class TaskPersistenceError extends Error {
  constructor(message = 'Task history could not be persisted.') {
    super(message)
    this.name = 'TaskPersistenceError'
  }
}

export class TaskScopeError extends Error {
  constructor(message = 'A valid authenticated task scope is required.') {
    super(message)
    this.name = 'TaskScopeError'
  }
}

interface PersistedTaskStore {
  version: 3
  owner: TaskOwnerScope
  updatedAt: number
  tasks: ClientTask[]
}

const MAX_SCOPE_SEGMENT_LENGTH = 256

function validateScopeSegment(value: string, name: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_SCOPE_SEGMENT_LENGTH ||
    value.includes('/') ||
    value.includes('\\') ||
    value === '.' ||
    value === '..'
  ) {
    throw new TaskScopeError(`Invalid task scope ${name}.`)
  }
}

export function encodeTaskScopeSegment(value: string, name: string): string {
  validateScopeSegment(value, name)
  return Buffer.from(value, 'utf8').toString('base64url')
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
  private readonly rootDir: string
  private readonly legacyRootDir: string
  private initialized = false
  private initialization: Promise<void> | null = null
  private readonly writeChains = new Map<string, Promise<void>>()

  constructor(private readonly userDataDir: string) {
    this.rootDir = join(userDataDir, 'task-data', 'v3')
    this.legacyRootDir = join(userDataDir, 'task-data', 'v2')
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    if (!this.initialization) {
      this.initialization = (async () => {
        await mkdir(this.rootDir, { recursive: true })
        await this.removeLegacyStore()
        this.initialized = true
      })()
    }
    await this.initialization
  }

  async load(scope: TaskOwnerScope): Promise<ClientTask[]> {
    this.ensureInitialized()
    const file = this.getTaskFile(scope)
    const backup = `${file}.bak`
    if (!await this.pathExists(file)) {
      if (!await this.pathExists(backup)) return []
      const recovered = await this.readFile(backup, scope)
      if (recovered) return recovered
      await this.quarantine(backup, 'backup')
      return []
    }

    const tasks = await this.readFile(file, scope)
    if (tasks) return tasks

    const recovered = await this.pathExists(backup) ? await this.readFile(backup, scope) : null
    if (recovered) {
      try {
        await copyFile(backup, file)
      } catch {
  // 保留备份文件，供下一次加载时使用。
      }
      return recovered
    }

    await this.quarantine(file, 'store')
    return []
  }

  save(scope: TaskOwnerScope, tasks: ClientTask[]): Promise<void> {
    this.ensureInitialized()
    const key = this.getScopeKey(scope)
    const prior = this.writeChains.get(key) ?? Promise.resolve()
    const write = prior.catch(() => undefined).then(() => this.writeSnapshot(scope, tasks))
    this.writeChains.set(key, write)
    return write.finally(() => {
      if (this.writeChains.get(key) === write) this.writeChains.delete(key)
    })
  }

  getTaskFileForTesting(scope: TaskOwnerScope): string {
    return this.getTaskFile(scope)
  }

  private async writeSnapshot(scope: TaskOwnerScope, tasks: ClientTask[]): Promise<void> {
    const file = this.getTaskFile(scope)
    const directory = join(file, '..')
    const temporaryFile = `${file}.${randomUUID()}.tmp`
    const backup = `${file}.bak`
    const envelope: PersistedTaskStore = {
      version: 3,
      owner: { ...scope },
      updatedAt: Date.now(),
      tasks: tasks.map(task => ({ ...task, files: [...task.files], logs: task.logs.map(log => ({ ...log })) })),
    }

    try {
      await mkdir(directory, { recursive: true })
      await writeFile(temporaryFile, JSON.stringify(envelope), { mode: 0o600 })
      try {
        await chmod(temporaryFile, 0o600)
      } catch {
  // 在不支持 chmod 的文件系统上，操作系统用户数据目录仍是主要隔离边界。
      }
      if (await this.pathExists(file)) {
        await copyFile(file, backup)
        await rm(file, { force: true })
      }
      await rename(temporaryFile, file)
    } catch (error) {
      try {
        await rm(temporaryFile, { force: true })
        if (!await this.pathExists(file) && await this.pathExists(backup)) await copyFile(backup, file)
      } catch {
  // 保留原始持久化错误。
      }
      throw new TaskPersistenceError(error instanceof Error ? error.message : undefined)
    }
  }

  private getScopeKey(scope: TaskOwnerScope): string {
    return `${encodeTaskScopeSegment(scope.enterpriseId, 'enterpriseId')}:${encodeTaskScopeSegment(scope.memberId, 'memberId')}`
  }

  private getTaskFile(scope: TaskOwnerScope): string {
    const enterprise = encodeTaskScopeSegment(scope.enterpriseId, 'enterpriseId')
    const member = encodeTaskScopeSegment(scope.memberId, 'memberId')
    return join(this.rootDir, enterprise, member, 'tasks.json')
  }

  private ensureInitialized(): void {
    if (!this.initialized) throw new TaskPersistenceError('Task store is not initialized.')
  }

  private async readFile(file: string, scope: TaskOwnerScope): Promise<ClientTask[] | null> {
    try {
      return parseEnvelope(JSON.parse(await readFile(file, 'utf8')) as unknown, scope)
    } catch {
      return null
    }
  }

  private async quarantine(file: string, kind: string): Promise<void> {
    if (!await this.pathExists(file)) return
    const quarantineFile = `${file}.corrupt-${kind}-${Date.now()}-${randomUUID()}.json`
    try {
      await rename(file, quarantineFile)
    } catch {
  // 损坏的文件不能阻止应用加载空的数据范围。
    }
  }

  private async removeLegacyStore(): Promise<void> {
    const legacyFile = join(this.userDataDir, 'tasks.json')
    if (await this.pathExists(this.legacyRootDir)) {
      try {
        await rm(this.legacyRootDir, { recursive: true, force: true })
      } catch (error) {
        throw new TaskPersistenceError(error instanceof Error ? error.message : 'Failed to remove v2 task data.')
      }
    }
    if (!await this.pathExists(legacyFile)) return
    try {
      await rm(legacyFile, { force: true })
    } catch (error) {
      console.warn('[TaskStore] Failed to remove deprecated task history:', error instanceof Error ? error.name : 'unknown')
    }
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await lstat(path)
      return true
    } catch {
      return false
    }
  }
}
