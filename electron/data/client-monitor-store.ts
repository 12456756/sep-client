import { randomUUID } from 'node:crypto'
import { readdir, rm } from 'node:fs/promises'
import { z } from 'zod'
import { ScopePath, type TaskOwnerScope } from './scope-path'
import { backupPath, diagnoseJsonWithBackup, readJsonWithBackup, writeJsonAtomic } from './atomic-file'
import { WriteChain } from './write-chain'
import {
  createClientTaskSchema,
  clientTaskEventSchema,
  clientTaskHeartbeatSchema,
  clientTaskStatusSchema,
  monitorParticipationSchema, normalizeMonitorStatus, normalizeMonitorParticipation,
  type ClientTaskEventRequest,
} from '../common/platform/client-monitor-contract'

const operationSchema = z.discriminatedUnion('kind', [
  z.object({ clientRunId: z.string().optional(), id: z.string(), kind: z.literal('create'), payload: createClientTaskSchema }),
  z.object({ clientRunId: z.string().optional(), id: z.string(), kind: z.literal('status'), payload: clientTaskStatusSchema }),
  z.object({ clientRunId: z.string().optional(), id: z.string(), kind: z.literal('heartbeat'), payload: clientTaskHeartbeatSchema }),
  z.object({
    clientRunId: z.string().optional(),
    id: z.string(),
    kind: z.literal('event'),
    sequence: z.number().int().positive(),
    payload: clientTaskEventSchema,
  }),
])
export type ClientMonitorOperation = z.infer<typeof operationSchema>
const liveRunSchema = z.object({
  protocolVersion: z.literal(2), participation: monitorParticipationSchema.optional(),
}).strict()
type LiveMonitorRun = z.infer<typeof liveRunSchema>

const contentIndexSchema = z.object({
  sourceId: z.string(), digest: z.string(), clientRunId: z.string(),
  sequences: z.array(z.number().int().positive().safe()),
  manifestSequence: z.number().int().positive().safe(), confirmed: z.boolean(),
  manifestFingerprint: z.string().optional(),
  wireMessageId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional(),
})
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
  retryAt: z.number().finite().optional(),
  retryStatusCode: z.number().optional(),
  historyBackfilled: z.boolean().optional(),
  skippedOldStatusCount: z.number().int().nonnegative().optional(),
  statusByRun: z.record(z.string(), z.string()).optional(),
  queuedStatusByRun: z.record(z.string(), z.string()).optional(),
  confirmedStatusByRun: z.record(z.string(), z.string()).optional(),
  contentIndex: z.record(z.string(), contentIndexSchema).optional(),
  sentEvents: z.array(clientTaskEventSchema).optional(),
  recoveryByRun: z.record(z.string(), z.string()).optional(),
  stateEvidenceByRun: z.record(z.string(), z.string()).optional(),
  liveRuns: z.record(z.string(), liveRunSchema).optional(),
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
  retryAt?: number
  retryStatusCode?: number
  historyBackfilled?: boolean
  skippedOldStatusCount?: number
  /** Legacy enqueued fingerprints, never interpreted as acknowledgements. */
  statusByRun?: Record<string, string>
  queuedStatusByRun?: Record<string, string>
  confirmedStatusByRun?: Record<string, string>
  contentIndex?: Record<string, z.infer<typeof contentIndexSchema>>
  sentEvents?: ClientTaskEventRequest[]
  recoveryByRun?: Record<string, string>
  stateEvidenceByRun?: Record<string, string>
  liveRuns?: Record<string, LiveMonitorRun>
}

export interface ClientMonitorStorePort {
  inspect?(scope: TaskOwnerScope, taskId: string): Promise<ClientMonitorRecord | null>
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

  async inspect(scope: TaskOwnerScope, taskId: string): Promise<ClientMonitorRecord | null> {
    const result = await diagnoseJsonWithBackup(this.paths.clientMonitorFile(scope, taskId),
      value => this.parseRecord(value, taskId))
    if (result.state === 'unavailable') throw new Error('Monitoring outbox is unavailable for inspection.')
    return result.state === 'found' ? result.value : null
  }

  async load(scope: TaskOwnerScope, taskId: string): Promise<ClientMonitorRecord | null> {
    const file = this.paths.clientMonitorFile(scope, taskId)
    return this.writes.run(this.writeKey(scope, taskId), async () => {
      const record = await readJsonWithBackup(file, value => this.parseRecord(value, taskId))
      if (!record) return null
      const normalized = normalizeMonitorRecord(record)
      if (normalized !== record) {
        await writeJsonAtomic(file, normalized, { backup: false })
        await rm(backupPath(file), { force: true })
      }
      return normalized
    })
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

/** Repair only attributable legacy timestamps, preserving every operation ID and its position. */
export function normalizeMonitorRecord(record: ClientMonitorRecord): ClientMonitorRecord {
  let changed = false
  let sequence = Math.max(record.lastSequence, ...record.pending.flatMap(op => op.kind === 'event' ? [op.sequence] : []))
  const statusByRun = { ...record.statusByRun }
  const queuedStatusByRun = { ...record.queuedStatusByRun }
  const pending: ClientMonitorOperation[] = []
  for (const operation of record.pending) {
    const runId = operation.clientRunId ?? operation.payload.clientRunId
    if (!runId) { pending.push(operation); continue }
    const originalParticipation = operation.kind === 'event' ? operation.payload.participation : undefined
    const normalizedParticipation = originalParticipation ? normalizeMonitorParticipation(originalParticipation) : undefined
    const payload = operation.kind === 'status' ? normalizeMonitorStatus(operation.payload) : operation.payload
    const endedAt = operation.kind === 'status' && payload !== operation.payload
      ? operation.payload.completedAt : normalizedParticipation !== originalParticipation ? originalParticipation?.completedAt : undefined
    if (!endedAt) { pending.push(operation); continue }
    changed = true
    const repaired = operation.kind === 'status'
      ? { ...operation, payload: normalizeMonitorStatus(operation.payload) }
      : operation.kind === 'event' ? { ...operation, payload: { ...operation.payload, participation: normalizedParticipation } } : operation
    pending.push(repaired)
    if (repaired.kind === 'status') {
      const { clientRunId: _runId, ...status } = repaired.payload
      statusByRun[runId] = JSON.stringify(status)
      queuedStatusByRun[runId] = JSON.stringify(status)
    }
    const reportedStatus = operation.kind === 'status' ? operation.payload.status : originalParticipation?.status
    if (!reportedStatus) continue
    const participation = normalizedParticipation ?? (record.liveRuns?.[runId]?.participation
      ? normalizeMonitorParticipation({ ...record.liveRuns[runId].participation!, status: reportedStatus }) : undefined)
    pending.push({ id: randomUUID(), kind: 'event', clientRunId: runId, sequence: ++sequence,
      payload: { clientRunId: runId, sequence, type: 'monitor_state', occurredAt: new Date(record.updatedAt).toISOString(),
        message: JSON.stringify({ version: 1, reportedStatus, source: 'snapshot', observedAt: new Date(record.updatedAt).toISOString(), runEndedAt: endedAt }),
        ...(participation ? { participation } : {}),
      },
    })
  }
  const liveRuns = record.liveRuns ? Object.fromEntries(Object.entries(record.liveRuns).map(([id, run]) => {
    const participation = run.participation ? normalizeMonitorParticipation(run.participation) : undefined
    if (participation !== run.participation) changed = true
    return [id, { ...run, ...(participation ? { participation } : {}) }]
  })) : undefined
  return changed ? { ...record, pending, lastSequence: sequence, statusByRun, queuedStatusByRun, ...(liveRuns ? { liveRuns } : {}) } : record
}
