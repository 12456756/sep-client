import { readJsonWithBackup, writeJsonAtomic } from './atomic-file'
import { WriteChain } from './write-chain'
import { ScopePath, type TaskOwnerScope } from './scope-path'

export type ConversationSyncStatus = 'pending' | 'syncing' | 'completed' | 'failed'

export interface ConversationSyncItem {
  id: string
  taskId: string
  runId: string
  role: 'user' | 'assistant'
  content: string
  clientConversationId: string
  clientMessageId: string
  subscriptionId: string
  modelId: string
  turnId: string
  createdAt: number
  status: ConversationSyncStatus
  retryCount: number
  nextRetryAt: number
  lastError?: string
}

export interface ConversationSyncStorePort {
  list(scope: TaskOwnerScope): Promise<ConversationSyncItem[]>
  save(scope: TaskOwnerScope, item: ConversationSyncItem): Promise<void>
  update(scope: TaskOwnerScope, clientMessageId: string, update: Partial<ConversationSyncItem>): Promise<void>
  recover(scope: TaskOwnerScope): Promise<void>
}

interface ConversationSyncFile {
  version: 1
  items: ConversationSyncItem[]
}

const STATUSES: readonly ConversationSyncStatus[] = ['pending', 'syncing', 'completed', 'failed']

function isConversationSyncStatus(value: unknown): value is ConversationSyncStatus {
  return typeof value === 'string' && STATUSES.includes(value as ConversationSyncStatus)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseItem(value: unknown): ConversationSyncItem | null {
  if (!isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.taskId !== 'string' ||
    typeof value.runId !== 'string' ||
    (value.role !== 'user' && value.role !== 'assistant') ||
    typeof value.content !== 'string' ||
    typeof value.clientConversationId !== 'string' ||
    typeof value.clientMessageId !== 'string' ||
    typeof value.subscriptionId !== 'string' ||
    typeof value.modelId !== 'string' ||
    typeof value.turnId !== 'string' ||
    typeof value.createdAt !== 'number' ||
    !isConversationSyncStatus(value.status) ||
    typeof value.retryCount !== 'number' ||
    typeof value.nextRetryAt !== 'number' ||
    (value.lastError !== undefined && typeof value.lastError !== 'string')) {
    return null
  }
  return {
    id: value.id,
    taskId: value.taskId,
    runId: value.runId,
    role: value.role,
    content: value.content,
    clientConversationId: value.clientConversationId,
    clientMessageId: value.clientMessageId,
    subscriptionId: value.subscriptionId,
    modelId: value.modelId,
    turnId: value.turnId,
    createdAt: value.createdAt,
    status: value.status,
    retryCount: value.retryCount,
    nextRetryAt: value.nextRetryAt,
    ...(value.lastError !== undefined ? { lastError: value.lastError } : {}),
  }
}

function parseFile(value: unknown): ConversationSyncFile | null {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.items)) return null
  const items = value.items.map(parseItem)
  if (items.some(item => item === null)) return null
  return { version: 1, items: items as ConversationSyncItem[] }
}

function cloneItem(item: ConversationSyncItem): ConversationSyncItem {
  return { ...item }
}

export class ConversationSyncStore implements ConversationSyncStorePort {
  private readonly paths: ScopePath
  private readonly writes = new WriteChain()

  constructor(userDataDir: string) {
    this.paths = new ScopePath(userDataDir)
  }

  list(scope: TaskOwnerScope): Promise<ConversationSyncItem[]> {
    return this.writes.run(this.paths.scopeKey(scope), async () => {
      const file = await this.read(scope)
      return file.items.map(cloneItem)
    })
  }

  save(scope: TaskOwnerScope, item: ConversationSyncItem): Promise<void> {
    return this.writes.run(this.paths.scopeKey(scope), async () => {
      this.assertItem(item)
      const file = await this.read(scope)
      if (file.items.some(existing => existing.clientMessageId === item.clientMessageId)) return
      await this.write(scope, { version: 1, items: [...file.items, cloneItem(item)] })
    })
  }

  update(scope: TaskOwnerScope, clientMessageId: string, update: Partial<ConversationSyncItem>): Promise<void> {
    return this.writes.run(this.paths.scopeKey(scope), async () => {
      const file = await this.read(scope)
      const index = file.items.findIndex(item => item.clientMessageId === clientMessageId)
      if (index < 0) return
      const updated = { ...file.items[index], ...update }
      this.assertItem(updated)
      const items = file.items.map((item, itemIndex) => itemIndex === index ? updated : item)
      await this.write(scope, { version: 1, items })
    })
  }

  recover(scope: TaskOwnerScope): Promise<void> {
    return this.writes.run(this.paths.scopeKey(scope), async () => {
      const file = await this.read(scope)
      const items = file.items.map(item => item.status === 'syncing' ? { ...item, status: 'pending' as const } : item)
      if (items.some((item, index) => item !== file.items[index])) {
        await this.write(scope, { version: 1, items })
      }
    })
  }

  private async read(scope: TaskOwnerScope): Promise<ConversationSyncFile> {
    return await readJsonWithBackup(this.paths.conversationSyncFile(scope), parseFile) ?? { version: 1, items: [] }
  }

  private write(scope: TaskOwnerScope, file: ConversationSyncFile): Promise<void> {
    return writeJsonAtomic(this.paths.conversationSyncFile(scope), file)
  }

  private assertItem(item: ConversationSyncItem): void {
    if (!parseItem(item)) throw new Error('Invalid conversation sync item.')
  }
}
