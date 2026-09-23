import { randomUUID } from 'node:crypto'
import { readdir, rm } from 'node:fs/promises'
import { z } from 'zod'
import { ScopePath, type TaskOwnerScope } from './scope-path'
import { backupPath, readJsonWithBackup, writeJsonAtomic } from './atomic-file'
import { WriteChain } from './write-chain'
import {
  createClientTaskSchema,
  clientTaskEventSchema,
  clientTaskHeartbeatSchema,
  clientTaskStatusSchema,
} from '../common/platform/client-monitor-contract'

const operationSchema = z.discriminatedUnion('kind', [
  z.object({ id: z.string(), kind: z.literal('create'), payload: createClientTaskSchema }),
  z.object({ id: z.string(), kind: z.literal('status'), payload: clientTaskStatusSchema }),
  z.object({ id: z.string(), kind: z.literal('heartbeat'), payload: clientTaskHeartbeatSchema }),
  z.object({
    id: z.string(),
    kind: z.literal('event'),
    sequence: z.number().int().positive(),
    payload: clientTaskEventSchema,
  }),
])
export type ClientMonitorOperation = z.infer<typeof operationSchema>

const recordMetadataSchema = z.object({
  version: z.literal(1),
  clientTaskId: z.string(),
  clientRunId: z.string(),
  mirrorId: z.string().nullable(),
  subscriptionId: z.string(),
  title: z.string(),
  taskType: z.enum(['conversation', 'arrangement']),
  modelId: z.string(),
  lastSequence: z.number().int().nonnegative().safe(),
  heartbeatActive: z.boolean(),
  updatedAt: z.number().finite(),
})
const recordSchema = recordMetadataSchema.extend({ pending: z.array(z.unknown()) })

export interface ClientMonitorRecord {
  version: 1
  clientTaskId: string
  clientRunId: string
  mirrorId: string | null
  subscriptionId: string
  title: string
  taskType: 'conversation' | 'arrangement'
  modelId: string
  lastSequence: number
  heartbeatActive: boolean
  pending: ClientMonitorOperation[]
  updatedAt: number
}

export interface ClientMonitorStorePort {
  load(scope: TaskOwnerScope, taskId: string): Promise<ClientMonitorRecord | null>
  listPending(scope: TaskOwnerScope): Promise<string[]>
  save(scope: TaskOwnerScope, taskId: string, record: ClientMonitorRecord): Promise<void>
  deleteIfEmpty(scope: TaskOwnerScope, taskId: string, record: ClientMonitorRecord): Promise<void>
}

export class ClientMonitorStore implements ClientMonitorStorePort {
  private readonly paths: ScopePath
  private readonly writes = new WriteChain()

  constructor(userDataDir: string) {
    this.paths = new ScopePath(userDataDir)
  }

  async load(scope: TaskOwnerScope, taskId: string): Promise<ClientMonitorRecord | null> {
    const file = this.paths.clientMonitorFile(scope, taskId)
    return readJsonWithBackup(file, value => this.parseRecord(value, taskId))
  }

  async listPending(scope: TaskOwnerScope): Promise<string[]> {
    try {
      const entries = await readdir(this.paths.clientMonitorRoot(scope), { withFileTypes: true })
      return entries
        .filter(entry => entry.isFile() && /^[A-Za-z0-9_-]{1,128}\.json$/.test(entry.name))
        .map(entry => entry.name.slice(0, -5))
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
  }

  save(scope: TaskOwnerScope, taskId: string, record: ClientMonitorRecord): Promise<void> {
    const file = this.paths.clientMonitorFile(scope, taskId)
    return this.writes.run(this.writeKey(scope, taskId), async () => {
      const parsed = this.parseRecord(record, taskId)
      if (!parsed) throw new Error('Invalid monitoring outbox write.')
      await writeJsonAtomic(file, parsed, { backup: false })
      await rm(backupPath(file), { force: true })
    })
  }

  deleteIfEmpty(scope: TaskOwnerScope, taskId: string, record: ClientMonitorRecord): Promise<void> {
    if (record.pending.length > 0 || record.heartbeatActive || record.mirrorId !== null) return Promise.resolve()
    const file = this.paths.clientMonitorFile(scope, taskId)
    return this.writes.run(this.writeKey(scope, taskId), async () => {
      await rm(file, { force: true })
      await rm(backupPath(file), { force: true })
    })
  }

  static operationId(): string {
    return randomUUID()
  }

  private parseRecord(value: unknown, taskId: string): ClientMonitorRecord | null {
    const outer = recordSchema.safeParse(value)
    if (!outer.success || outer.data.clientTaskId !== taskId) return null
    const pending = outer.data.pending.flatMap(operation => {
      const parsed = operationSchema.safeParse(operation)
      return parsed.success ? [parsed.data] : []
    })
    return { ...outer.data, pending }
  }

  private writeKey(scope: TaskOwnerScope, taskId: string): string {
    return `${this.paths.scopeKey(scope)}:${taskId}`
  }
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}
