import { createHash } from 'node:crypto'
import { logger } from '../common/logger'
import { redactText } from '../common/redact'
import { ClientMonitorApiError, type ClientMonitorApiPort, type ClientTaskStatusRequest } from '../common/platform/client-monitor-api'
import { monitorParticipationSchema, monitorMetadataSchemas, contentManifestSchema, normalizeMonitorStatus, normalizeMonitorParticipation,
  type MonitorParticipation, type MonitorState, type ContentManifest, type ContentRecovery, type ClientTaskEventRequest } from '../common/platform/client-monitor-contract'
import { ClientMonitorStore, normalizeMonitorRecord, type ClientMonitorOperation, type ClientMonitorRecord, type ClientMonitorStorePort } from '../data/client-monitor-store'
import type { TaskOwnerScope } from '../data/scope-path'
import type { TaskExecutionEvent } from '../../src/shared/types'
import type { MonitorTaskQueuedInput, MonitorTaskStartedInput, MonitorTaskFinishedInput, MonitorTaskContentInput } from '../domain/task-monitor'
import type { ClientMonitorHistorySource, MonitorHistoryTask } from './client-monitor-history-service'

export type ClientMonitorTaskQueuedInput = MonitorTaskQueuedInput
export type ClientMonitorTaskStartedInput = MonitorTaskStartedInput
export type ClientMonitorTaskFinishedInput = MonitorTaskFinishedInput
export type ClientMonitorTaskContentInput = MonitorTaskContentInput

const log = logger.child('client-monitor')
const scopeKey = (scope: TaskOwnerScope | null): string => scope ? `${scope.enterpriseId}\0${scope.memberId}` : ''
const boundedText = (text: string, length: number): string => redactText(text, Infinity).slice(0, length)
const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
const stableId = (sourceId: string): string => {
  const encoded = Buffer.from(sourceId).toString('base64url')
  return encoded.length <= 100 ? encoded : digest(sourceId)
}
const contentIdentity = (input: MonitorTaskContentInput, type: 'user_input' | 'model_output', participation = input.participation): string => {
  const sourceId = input.messageId ?? (participation?.nodeId
    ? `${input.runId}:${participation.executionId}:${type}` : `${input.runId}-${type === 'user_input' ? 'user' : 'assistant'}`)
  return input.messageId ? sourceId : `${sourceId}:${digest(redactText(input.content, Infinity))}`
}
const contentEvents = (record: ClientMonitorRecord): ClientTaskEventRequest[] => [
  ...(record.sentEvents ?? []), ...record.pending.flatMap(op => op.kind === 'event' ? [op.payload] : []),
]
function manifestData(event: ClientTaskEventRequest | undefined): ContentManifest | undefined {
  if (event?.type !== 'content_manifest') return
  try {
    const parsed = contentManifestSchema.safeParse(JSON.parse(event.message ?? ''))
    return parsed.success ? parsed.data : undefined
  } catch { return }
}
const completenessRank = { unverified: 0, partial: 1, complete: 2 }
const sameParticipation = (left?: MonitorParticipation, right?: MonitorParticipation): boolean =>
  left?.executionId === right?.executionId && left?.subscriptionId === right?.subscriptionId && left?.nodeId === right?.nodeId

// Never split a surrogate pair. Each wire message still satisfies Zod's UTF-16 max(1000).
function chunks(text: string): string[] {
  const parts: string[] = []
  let part = ''
  for (const character of text) {
    if (part.length + character.length > 1000) { parts.push(part); part = '' }
    part += character
  }
  if (part) parts.push(part)
  return parts
}

export interface ClientMonitorServiceOptions {
  store: ClientMonitorStorePort
  api: ClientMonitorApiPort
  scopeProvider: () => TaskOwnerScope | null
  history?: ClientMonitorHistorySource
  clientVersion?: string
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  maxAttempts?: number
  recoveryIntervalMs?: number
  minSendIntervalMs?: number
}

export interface ClientMonitorRecoveryPreview {
  tasks: number
  normalizedOperations: number
  bodyMessages: number
  bodyChunks: number
  metadataEvents: number
  ambiguous: number
  sourceMissing: number
  /** Local-only preview cannot certify already accepted cloud events. */
  cloudReconciliationRequired: boolean
}

/** Atomic per-task mutations; one global wire queue. Network waits never hold mutation locks. */
export class ClientMonitorService {
  private readonly chains = new Map<string, Promise<void>>()
  private sendTail: Promise<void> = Promise.resolve()
  private recovery: Promise<void> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private controller = new AbortController()
  private epoch = 0
  private stopped = false
  private blockedUntil = 0
  private lastSentAt = 0
  private readonly now: () => number
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly maxAttempts: number
  private readonly clientVersion: string

  constructor(private readonly options: ClientMonitorServiceOptions) {
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.maxAttempts = Math.max(1, Math.min(10, options.maxAttempts ?? 3))
    this.clientVersion = options.clientVersion ?? '1.0.0'
  }

  taskQueued(input: MonitorTaskQueuedInput): Promise<void> {
    return this.enqueue(input.taskId, async scope => {
      const record = await this.options.store.load(scope, input.taskId)
      await this.options.store.save(scope, input.taskId, this.queueRun(record, input))
    })
  }

  taskStarted(input: MonitorTaskStartedInput): Promise<void> {
    return this.enqueueStatus(input.taskId, input.runId, { status: 'RUNNING', startedAt: new Date(input.startedAt).toISOString() })
  }

  taskInput(input: MonitorTaskContentInput): Promise<void> { return this.enqueueContent(input, 'user_input') }
  taskOutput(input: MonitorTaskContentInput): Promise<void> { return this.enqueueContent(input, 'model_output') }

  taskEvent(event: TaskExecutionEvent, participation?: MonitorParticipation): Promise<void> {
    if (participation) {
      return this.enqueue(event.taskId, async scope => {
        const record = await this.options.store.load(scope, event.taskId)
        if (!record?.liveRuns?.[event.runId]) return
        await this.options.store.save(scope, event.taskId, this.addParticipation(record, event.runId, participation, event.occurredAt))
      })
    }
    if (event.type === 'approval_requested' || event.type === 'approval_resolved') {
      return this.enqueueStatus(event.taskId, event.runId, { status: event.type === 'approval_requested' ? 'WAITING_APPROVAL' : 'RUNNING' })
    }
    // Tool arguments/results and streaming deltas are not public monitor content.
    return Promise.resolve()
  }

  taskFinished(input: MonitorTaskFinishedInput): Promise<void> {
    return this.enqueueStatus(input.taskId, input.runId, {
      status: input.status,
      ...(input.status === 'COMPLETED' ? { progress: 100 } : {}),
      errorSummary: input.error ? boundedText(input.error, 1000) : null,
      completedAt: new Date(input.completedAt).toISOString(),
    }, new Date(input.completedAt).toISOString())
  }

  async previewRecovery(): Promise<ClientMonitorRecoveryPreview | null> {
    const scope = this.options.scopeProvider()
    if (!scope) return null
    const inspect = this.options.store.inspect
    if (!inspect) throw new Error('Read-only monitoring inspection is unavailable.')
    const epoch = this.epoch
    const current = (): boolean => scopeKey(scope) === scopeKey(this.options.scopeProvider()) && epoch === this.epoch
    const tasks = await this.options.history?.read(scope) ?? []
    if (!current()) return null
    const ids = new Set([...await this.options.store.listPending(scope), ...tasks.map(task => task.taskId)])
    const result: ClientMonitorRecoveryPreview = { tasks: ids.size, normalizedOperations: 0,
      bodyMessages: 0, bodyChunks: 0, metadataEvents: 0, ambiguous: 0, sourceMissing: 0,
      cloudReconciliationRequired: false }
    for (const id of ids) {
      if (!current()) return null
      const original = await inspect.call(this.options.store, scope, id)
      if (!current()) return null
      const normalized = original ? normalizeMonitorRecord(structuredClone(original)) : null
      result.normalizedOperations += original?.pending.filter(operation => {
        const repaired = normalized?.pending.find(candidate => candidate.id === operation.id)
        return repaired && JSON.stringify(repaired.payload) !== JSON.stringify(operation.payload)
      }).length ?? 0
      const task = tasks.find(candidate => candidate.taskId === id)
      const projected = task ? this.restoreRecord(normalized, task) : normalized
      const oldIds = new Set(original?.pending.map(operation => operation.id))
      const added = projected?.pending.filter(operation => !oldIds.has(operation.id)) ?? []
      const messages = new Set<string>()
      for (const operation of added) {
        if (operation.kind !== 'event') continue
        if (operation.payload.type === 'user_input' || operation.payload.type === 'model_output') {
          result.bodyChunks++
          messages.add(JSON.stringify([operation.clientRunId, operation.payload.type,
            operation.payload.stepKey?.split(':').slice(0, 3)]))
        } else if (Object.prototype.hasOwnProperty.call(monitorMetadataSchemas, operation.payload.type)) {
          result.metadataEvents++
        }
      }
      result.bodyMessages += messages.size
      for (const reason of Object.values(projected?.recoveryByRun ?? {})) {
        if (reason === 'ambiguous') result.ambiguous++
        if (reason === 'source-missing') result.sourceMissing++
      }
      if (original?.mirrorId && task) result.cloudReconciliationRequired = true
    }
    return current() ? result : null
  }

  resumePending(): Promise<void> {
    const scope = this.options.scopeProvider()
    if (!scope) return Promise.resolve()
    if (this.stopped) { this.stopped = false; this.controller = new AbortController() }
    if (!this.timer) {
      this.timer = setInterval(() => { void this.resumePending() }, this.options.recoveryIntervalMs ?? 30_000)
      this.timer.unref?.()
    }
    if (this.recovery) return this.recovery
    const epoch = this.epoch
    const recovery = this.recover(scope, epoch).catch(() => {
      log.warn('client monitor recovery failed')
    }).finally(() => { if (this.recovery === recovery) this.recovery = null })
    this.recovery = recovery
    return recovery
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.epoch++
    this.controller.abort()
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.recovery = null
    this.blockedUntil = 0
    this.lastSentAt = 0
    // Aborted old requests cannot hold the new login's wire queue.
    this.sendTail = Promise.resolve()
  }

  private async recover(scope: TaskOwnerScope, epoch: number): Promise<void> {
    const ids = await this.options.store.listPending(scope)
    if (!this.valid(scope, epoch)) return
    // Restore a persisted 429 gate before attempting *any* task.
    for (const id of ids) {
      const record = await this.options.store.load(scope, id)
      if (!this.valid(scope, epoch)) return
      if (record?.retryStatusCode === 429) this.blockedUntil = Math.max(this.blockedUntil, record.retryAt ?? 0)
    }
    if (this.options.history) {
      const tasks = await this.options.history.read(scope)
      for (const task of tasks) {
        if (!this.valid(scope, epoch)) return
        const existing = await this.options.store.load(scope, task.taskId)
        let remote: ClientTaskEventRequest[] | undefined
        const unresolved = task.runs.some(run => run.messages.some(message => {
          const identity = contentIdentity({ ...message, taskId: task.taskId, runId: run.runId }, message.type)
          const entry = existing?.contentIndex?.[`${run.runId}:${stableId(identity)}`]
          return !entry || !manifestData(contentEvents(existing!).find(event => event.clientRunId === run.runId && event.sequence === entry.manifestSequence))
        }))
        if (existing?.mirrorId && this.options.api.getDetail && unresolved && this.blockedUntil <= this.now()) {
          try {
            const detail = await this.callWithRetry(scope, epoch, () => this.options.api.getDetail!(existing.mirrorId!, this.controller.signal))
            if (detail.clientTaskId !== task.taskId) continue
            remote = detail.events
          } catch { log.warn('client monitor history reconciliation unavailable', { taskId: task.taskId }) }
        }
        if (!this.valid(scope, epoch)) return
        await this.mutate(scope, task.taskId, epoch, () => this.restoreHistory(scope, task, remote))
      }
    }
    const allIds = await this.options.store.listPending(scope)
    for (const id of allIds) {
      if (!this.valid(scope, epoch)) return
      await this.scheduleDrain(scope, id, epoch)
    }
  }

  private async restoreHistory(scope: TaskOwnerScope, task: MonitorHistoryTask, remote?: ClientTaskEventRequest[]): Promise<void> {
    const record = this.restoreRecord(await this.options.store.load(scope, task.taskId), task, remote)
    if (record) await this.options.store.save(scope, task.taskId, record)
  }

  private restoreRecord(initial: ClientMonitorRecord | null, task: MonitorHistoryTask, remote?: ClientTaskEventRequest[]): ClientMonitorRecord | null {
    let record = initial
    const backfill = !record
    for (const run of task.runs) {
      if (backfill) {
        record = this.queueRun(record, { ...run, taskId: task.taskId, title: task.title, taskType: task.taskType })
      }
      if (record && !backfill && record.mirrorId === null && run.localRun && run.queuedAt !== undefined && Number.isFinite(new Date(run.queuedAt).getTime())) {
        const queuedAt = new Date(run.queuedAt).toISOString()
        record = { ...record, pending: record.pending.map(operation => {
          if (operation.kind !== 'create' || operation.payload.queuedAt !== undefined ||
            operation.payload.clientTaskId !== task.taskId || operation.payload.clientRunId !== run.runId ||
            operation.payload.subscriptionId !== run.subscriptionId ||
            (operation.clientRunId !== undefined && operation.clientRunId !== run.runId)) return operation
          return { ...operation, payload: { ...operation.payload, queuedAt } }
        }) }
      }
      if (!record) continue
      if (remote) record = { ...record, lastSequence: Math.max(record.lastSequence, ...remote.map(event => event.sequence)), sentEvents: [...new Map([...remote, ...(record.sentEvents ?? [])].map(event => [JSON.stringify([event.clientRunId, event.sequence]), event])).values()] }
      for (const message of run.messages) {
        if (!Number.isFinite(message.occurredAt) || !Number.isFinite(new Date(message.occurredAt).getTime())) continue
        const duplicate = run.messages.filter(other => other.type === message.type && other.content === message.content).length > 1
        record = this.addContent(record, { ...message, taskId: task.taskId, runId: run.runId }, message.type, message.occurredAt, true, duplicate)
      }
      if (run.status && run.runId === record.clientRunId) {
        const fingerprint = this.fingerprint(run.status)
        if (record.queuedStatusByRun?.[run.runId] !== fingerprint && record.confirmedStatusByRun?.[run.runId] !== fingerprint) {
          record = this.addStatus(record, run.runId, run.status, run.localRun ? 'local-run' : 'snapshot', run.runEndedAt)
        } else {
          record = this.addState(record, run.runId, run.status, run.localRun ? 'local-run' : 'snapshot', run.runEndedAt)
        }
      }
      if (run.recoveryReason) {
        record = this.addRecovery(record, run.runId, run.recoveryReason)
      }
    }
    return record ? { ...record, historyBackfilled: record.historyBackfilled || backfill } : null
  }

  private enqueueContent(input: MonitorTaskContentInput, type: 'user_input' | 'model_output'): Promise<void> {
    if (input.content.length === 0) return Promise.resolve()
    return this.enqueue(input.taskId, async scope => {
      const record = await this.options.store.load(scope, input.taskId)
      if (!record) return
      await this.options.store.save(scope, input.taskId, this.addContent(record, input, type, input.occurredAt ?? this.now()))
    })
  }

  private addContent(record: ClientMonitorRecord, input: MonitorTaskContentInput, type: 'user_input' | 'model_output', occurredAt: number, historical = false, duplicate = false): ClientMonitorRecord {
    if (input.content.length === 0) return record
    const text = redactText(input.content, Infinity)
    const parts = chunks(text)
    const liveRun = record.liveRuns?.[input.runId]
    const participation = liveRun ? this.participation(input.participation ?? liveRun.participation) : undefined
    const identity = contentIdentity(input, type, participation)
    let messageId = stableId(identity)
    const key = `${input.runId}:${messageId}`
    const existing = record.contentIndex?.[key]
    const manifestFingerprint = JSON.stringify([input.source ?? 'canonical', input.completeness ?? (type === 'user_input' ? 'complete' : 'unverified')])
    if (existing && existing.digest === digest(text)) {
      if (existing.manifestFingerprint === manifestFingerprint || !historical) return record
      const prior = manifestData(contentEvents(record).find(event => event.clientRunId === input.runId &&
        event.sequence === existing.manifestSequence && sameParticipation(event.participation, participation)))
      if (!prior || prior.type !== type || prior.messageId !== (existing.wireMessageId ?? messageId) ||
        prior.chunks !== existing.sequences.length || (prior.legacySequences &&
          JSON.stringify(prior.legacySequences) !== JSON.stringify(existing.sequences))) return record
      const manifest = { ...prior, source: input.source ?? 'canonical', completeness: input.completeness ?? (type === 'user_input' ? 'complete' : 'unverified') }
      // New evidence may strengthen coverage; unverified recovery cannot downgrade a live complete reply.
      if (completenessRank[manifest.completeness] <= completenessRank[prior.completeness]) return record
      const updated = this.addMetadata(record, input.runId, 'content_manifest', manifest, participation, occurredAt)
      return { ...updated, contentIndex: { ...record.contentIndex, [key]: { ...existing, manifestSequence: updated.lastSequence, confirmed: false, manifestFingerprint } } }
    }
    if (existing) return this.addRecovery(record, input.runId, 'ambiguous', participation)
    let legacySequences: number[] | undefined
    let replacesSequences: number[] | undefined
    let replacesMessageId: string | undefined
    if (historical) {
      const claimed = new Set(Object.values(record.contentIndex ?? {}).flatMap(entry => entry.sequences))
      const events = contentEvents(record)
        .filter(event => event.clientRunId === input.runId && event.type === type &&
          !claimed.has(event.sequence) &&
          sameParticipation(event.participation, participation))
      const groups = new Map<string, ClientTaskEventRequest[]>()
      for (const event of events) {
        const id = event.stepKey?.match(/^content:v1:([^:]+):\d+:\d+$/)?.[1] ?? `sequence-${event.sequence}`
        const group = groups.get(id) ?? []
        if (!group.some(item => item.sequence === event.sequence)) group.push(event)
        groups.set(id, group)
      }
      const assembled = [...groups.entries()].map(([id, group]) => {
        const headers = group.map(event => event.stepKey?.match(/^content:v1:([^:]+):(\d+):(\d+)$/))
        const stable = headers.every(Boolean)
        const total = stable ? Number(headers[0]![3]) : 1
        const valid = !stable || (Number.isSafeInteger(total) && total > 0 && total === group.length &&
          headers.every(header => Number(header![3]) === total && Number(header![2]) < total) &&
          new Set(headers.map(header => Number(header![2]))).size === total)
        group.sort((a, b) => stable ? Number(a.stepKey!.split(':')[3]) - Number(b.stepKey!.split(':')[3]) : a.sequence - b.sequence)
        return { id, group, stable, valid, text: group.map(event => event.message ?? '').join('') }
      })
      if (assembled.some(candidate => candidate.id === messageId && (!candidate.valid || candidate.text !== text))) {
        return this.addRecovery(record, input.runId, 'ambiguous', participation)
      }
      let candidates = assembled.filter(candidate => candidate.valid && (candidate.text === text || (candidate.text.length > 0 && text.startsWith(candidate.text) &&
        candidate.group.every(event => Date.parse(event.occurredAt) === occurredAt))))
      const exactTime = candidates.filter(candidate => candidate.group.every(event => Date.parse(event.occurredAt) === occurredAt))
      if (exactTime.length) candidates = exactTime
      if (candidates.length > 1 || (duplicate && candidates.some(candidate => candidate.group.some(event => Date.parse(event.occurredAt) !== occurredAt)))) {
        return this.addRecovery(record, input.runId, 'ambiguous', participation)
      }
      const match = candidates[0]
      if (match) {
        const sequences = match.group.map(event => event.sequence)
        if (match.text === text && match.stable) {
          messageId = match.id
          const priorEvents = contentEvents(record).filter(event => event.clientRunId === input.runId &&
            sameParticipation(event.participation, participation))
          const priorEvent = priorEvents.filter(event => {
            const data = manifestData(event)
            return data?.messageId === messageId && data.type === type && !data.legacySequences && data.chunks === sequences.length
          }).sort((a, b) => b.sequence - a.sequence)[0]
          const prior = manifestData(priorEvent)
          if (prior && priorEvent) {
            const mapped = { ...record, contentIndex: { ...record.contentIndex, [key]: {
              sourceId: identity, digest: digest(text), clientRunId: input.runId, wireMessageId: messageId,
              sequences, manifestSequence: priorEvent.sequence,
              confirmed: !record.pending.some(op => op.kind === 'event' && op.clientRunId === input.runId && op.sequence === priorEvent.sequence),
              manifestFingerprint: JSON.stringify([prior.source, prior.completeness]),
            } } }
            return this.addContent(mapped, input, type, occurredAt, historical, duplicate)
          }
          const manifest: ContentManifest = { version: 1, messageId, type, chunks: sequences.length,
            source: input.source ?? 'canonical', completeness: input.completeness ?? (type === 'user_input' ? 'complete' : 'unverified') }
          const updated = this.addMetadata(record, input.runId, 'content_manifest', manifest, participation, occurredAt)
          return { ...updated, contentIndex: { ...record.contentIndex, [key]: { sourceId: identity, digest: digest(text), clientRunId: input.runId,
            wireMessageId: messageId, sequences, manifestSequence: updated.lastSequence, confirmed: false, manifestFingerprint } } }
        }
        if (sequences.length > 64) return this.addRecovery(record, input.runId, 'ambiguous', participation)
        if (match.text === text) legacySequences = sequences
        else {
          if (input.completeness !== 'complete') return this.addRecovery(record, input.runId, 'ambiguous', participation)
          if (/^[A-Za-z0-9_-]{1,100}$/.test(match.id) && !match.id.startsWith('sequence-')) replacesMessageId = match.id
          else replacesSequences = sequences
        }
      } else if (record.lastSequence > 0 && record.sentEvents === undefined) {
        // The old outbox does not prove what the cloud already accepted.
        return this.addRecovery(record, input.runId, 'ambiguous', participation)
      }
    }
    let sequence = record.lastSequence
    const operations: ClientMonitorOperation[] = legacySequences ? [] : parts.map((message, index) => ({
      id: ClientMonitorStore.operationId(), kind: 'event', clientRunId: input.runId, sequence: ++sequence,
      payload: {
        clientRunId: input.runId, sequence, type, message,
        stepKey: `content:v1:${messageId}:${index}:${parts.length}`,
        occurredAt: new Date(occurredAt).toISOString(),
        ...(participation ? { participation } : {}),
      },
    }))
    const sequences = legacySequences ?? operations.flatMap(op => op.kind === 'event' ? [op.sequence] : [])
    const manifest: ContentManifest = { version: 1, messageId, type, chunks: legacySequences?.length ?? parts.length,
      source: input.source ?? 'canonical', completeness: input.completeness ?? (type === 'user_input' ? 'complete' : 'unverified'),
      ...(legacySequences ? { legacySequences } : {}), ...(replacesSequences ? { replacesSequences } : {}), ...(replacesMessageId ? { replacesMessageId } : {}),
    }
    // Check the final JSON before mutating either body operations or the durable index.
    if (JSON.stringify(manifest).length > 1000) return this.addRecovery(record, input.runId, 'ambiguous', participation)
    const updated = this.addMetadata({ ...record, lastSequence: sequence, pending: [...record.pending, ...operations], updatedAt: this.now() }, input.runId, 'content_manifest', manifest, participation, occurredAt)
    return { ...updated, contentIndex: { ...record.contentIndex, [key]: { sourceId: identity, digest: digest(text), clientRunId: input.runId,
      sequences, manifestSequence: updated.lastSequence, confirmed: false, manifestFingerprint } } }
  }

  private enqueueStatus(taskId: string, runId: string, payload: ClientTaskStatusRequest, endedAt?: string): Promise<void> {
    return this.enqueue(taskId, async scope => {
      const record = await this.options.store.load(scope, taskId)
      if (record) await this.options.store.save(scope, taskId, this.addStatus(record, runId, payload, 'live', endedAt))
    })
  }

  private fingerprint(payload: ClientTaskStatusRequest): string { return JSON.stringify(this.statusPayload(payload)) }

  private statusPayload(payload: ClientTaskStatusRequest): ClientTaskStatusRequest {
    const { clientRunId: _runId, ...normalized } = normalizeMonitorStatus(payload)
    return { ...normalized, ...(payload.errorSummary ? { errorSummary: boundedText(payload.errorSummary, 1000) } : {}) }
  }

  private addStatus(record: ClientMonitorRecord, runId: string, payload: ClientTaskStatusRequest, source: MonitorState['source'] = 'live', endedAt?: string): ClientMonitorRecord {
    const statusByRun = { ...record.statusByRun, [runId]: this.fingerprint(payload) }
    const updated = { ...record, statusByRun, queuedStatusByRun: { ...record.queuedStatusByRun, [runId]: this.fingerprint(payload) }, updatedAt: this.now(), pending: [...record.pending, {
      id: ClientMonitorStore.operationId(), kind: 'status', clientRunId: runId, payload: { ...this.statusPayload(payload), clientRunId: runId },
    } as ClientMonitorOperation] }
    const participation = record.liveRuns?.[runId]?.participation
    if (!participation) return this.addState(updated, runId, payload, source, endedAt)
    const snapshot = this.participation({
      ...participation, status: payload.status,
      ...(payload.startedAt ? { startedAt: payload.startedAt } : {}),
      completedAt: normalizeMonitorStatus(payload).completedAt ?? undefined,
    })!
    const withParticipation = this.addParticipation({ ...updated, liveRuns: { ...record.liveRuns,
      [runId]: { protocolVersion: 2, participation: snapshot },
    } }, runId, snapshot, payload.completedAt || payload.startedAt ? Date.parse((payload.completedAt || payload.startedAt)!) : this.now())
    return this.addState(withParticipation, runId, payload, source, endedAt)
  }

  private participation(value?: MonitorParticipation): MonitorParticipation | undefined {
    if (!value) return undefined
    return monitorParticipationSchema.parse({ ...normalizeMonitorParticipation(value),
      ...(value.title ? { title: boundedText(value.title, 200) || 'Task' } : {}),
    })
  }

  private addMetadata(record: ClientMonitorRecord, runId: string, type: keyof typeof monitorMetadataSchemas,
    metadata: MonitorState | ContentManifest | ContentRecovery, participation?: MonitorParticipation, occurredAt = this.now()): ClientMonitorRecord {
    const message = JSON.stringify(monitorMetadataSchemas[type].parse(metadata))
    if (message.length > 1000) throw new Error('Monitor metadata exceeds wire limit')
    const sequence = record.lastSequence + 1
    return { ...record, lastSequence: sequence, updatedAt: this.now(), pending: [...record.pending, {
      id: ClientMonitorStore.operationId(), kind: 'event', clientRunId: runId, sequence,
      payload: { clientRunId: runId, sequence, type, message, occurredAt: new Date(occurredAt).toISOString(),
        ...(participation ? { participation: this.participation(participation) } : {}) },
    }] }
  }

  private addState(record: ClientMonitorRecord, runId: string, payload: ClientTaskStatusRequest, source: MonitorState['source'], endedAt?: string): ClientMonitorRecord {
    const evidence = { version: 1 as const, reportedStatus: payload.status, source,
      ...(endedAt ?? payload.completedAt ? { runEndedAt: endedAt ?? payload.completedAt! } : {}),
      ...(payload.progress !== undefined ? { progress: payload.progress } : {}) }
    const key = JSON.stringify(evidence)
    if (record.stateEvidenceByRun?.[runId] === key) return record
    const updated = this.addMetadata(record, runId, 'monitor_state', { ...evidence, observedAt: new Date(this.now()).toISOString() }, record.liveRuns?.[runId]?.participation)
    return { ...updated, stateEvidenceByRun: { ...record.stateEvidenceByRun, [runId]: key } }
  }

  private addRecovery(record: ClientMonitorRecord, runId: string, reason: ContentRecovery['reason'], participation = record.liveRuns?.[runId]?.participation): ClientMonitorRecord {
    const key = `${runId}:${participation?.executionId ?? ''}`
    if (record.recoveryByRun?.[key] === reason) return record
    const updated = this.addMetadata(record, runId, 'content_recovery', { version: 1, reason, source: 'local-history', checkedAt: new Date(this.now()).toISOString() }, participation)
    return { ...updated, recoveryByRun: { ...record.recoveryByRun, [key]: reason } }
  }

  private addParticipation(record: ClientMonitorRecord, runId: string, value: MonitorParticipation, occurredAt: number): ClientMonitorRecord {
    const sequence = record.lastSequence + 1
    const normalized = this.participation(value)
    const updated = { ...record, lastSequence: sequence, updatedAt: this.now(), pending: [...record.pending, {
      id: ClientMonitorStore.operationId(), kind: 'event', clientRunId: runId, sequence,
      payload: { clientRunId: runId, sequence, type: 'participation_status',
        participation: normalized, occurredAt: new Date(occurredAt).toISOString() },
    } as ClientMonitorOperation] }
    return value.completedAt && value.completedAt !== normalized?.completedAt && value.status
      ? this.addMetadata(updated, runId, 'monitor_state', { version: 1, reportedStatus: value.status, source: 'live',
        observedAt: new Date(occurredAt).toISOString(), runEndedAt: value.completedAt }, normalized, occurredAt) : updated
  }

  private queueRun(existing: ClientMonitorRecord | null, input: MonitorTaskQueuedInput): ClientMonitorRecord {
    const title = boundedText(input.title, 200) || 'Task'
    const record: ClientMonitorRecord = existing ?? {
      version: 1, clientTaskId: input.taskId, clientRunId: input.runId, mirrorId: null,
      subscriptionId: input.subscriptionId, title, taskType: input.taskType, modelId: input.modelId,
      lastSequence: 0, heartbeatActive: false, pending: [], updatedAt: this.now(), contentIndex: {}, sentEvents: [],
    }
    const create = !existing || record.clientRunId !== input.runId
    const participation = input.protocolVersion === 2 ? this.participation(input.participation) : undefined
    const updated: ClientMonitorRecord = { ...record, clientRunId: input.runId, subscriptionId: input.subscriptionId, title,
      taskType: input.taskType, modelId: input.modelId, updatedAt: this.now(),
      ...(create && input.protocolVersion === 2 ? { liveRuns: { ...record.liveRuns,
        [input.runId]: { protocolVersion: 2, ...(participation ? { participation } : {}) },
      } } : {}),
      pending: create ? [...record.pending, {
        id: ClientMonitorStore.operationId(), kind: 'create', clientRunId: input.runId,
        payload: { clientTaskId: input.taskId, clientRunId: input.runId, subscriptionId: input.subscriptionId,
          title, taskType: input.taskType, modelId: input.modelId, clientVersion: this.clientVersion,
          ...(input.protocolVersion === 2 ? { protocolVersion: 2 } : {}),
          ...(input.queuedAt !== undefined || input.protocolVersion === 2 ? { queuedAt: new Date(input.queuedAt ?? this.now()).toISOString() } : {}),
        },
      }] : record.pending,
    }
    const withParticipation = create && participation ? this.addParticipation(updated, input.runId, { ...participation, status: 'QUEUED' }, input.queuedAt ?? this.now()) : updated
    return create && input.protocolVersion === 2 ? this.addState(withParticipation, input.runId, { status: 'QUEUED' }, 'live') : withParticipation
  }

  private valid(scope: TaskOwnerScope, epoch: number): boolean {
    return !this.stopped && this.epoch === epoch && scopeKey(scope) === scopeKey(this.options.scopeProvider())
  }

  private enqueue(taskId: string, mutation: (scope: TaskOwnerScope) => Promise<void>): Promise<void> {
    const scope = this.options.scopeProvider()
    if (!scope || this.stopped) return Promise.resolve()
    const epoch = this.epoch
    return this.mutate(scope, taskId, epoch, () => mutation(scope)).then(() => this.scheduleDrain(scope, taskId, epoch))
  }

  private mutate(scope: TaskOwnerScope, taskId: string, epoch: number, mutation: () => Promise<void>, propagateFailure = false): Promise<void> {
    const key = `${scopeKey(scope)}\0${taskId}`
    const previous = this.chains.get(key) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(async () => { if (this.valid(scope, epoch)) await mutation() }).catch((error: unknown) => {
      log.warn('client monitor outbox mutation failed', { taskId })
      if (propagateFailure) throw error
    })
    this.chains.set(key, next)
    return next.finally(() => { if (this.chains.get(key) === next) this.chains.delete(key) })
  }

  private scheduleDrain(scope: TaskOwnerScope, taskId: string, epoch: number): Promise<void> {
    const next = this.sendTail.then(() => this.processPending(scope, taskId, epoch)).catch(() => {
      log.warn('client monitor send failed', { taskId })
    })
    this.sendTail = next
    return next
  }

  private async processPending(scope: TaskOwnerScope, taskId: string, epoch: number): Promise<void> {
    while (this.valid(scope, epoch)) {
      await this.mutate(scope, taskId, epoch, async () => {
        const latest = await this.options.store.load(scope, taskId)
        if (!latest) return
        const normalized = normalizeMonitorRecord(latest)
        if (normalized !== latest) await this.options.store.save(scope, taskId, normalized)
      }, true)
      const record = await this.options.store.load(scope, taskId)
      if (!this.valid(scope, epoch) || !record) return
      const operation = record.pending[0]
      if (!operation || Math.max(record.retryAt ?? 0, this.blockedUntil) > this.now()) return
      if (operation.kind !== 'create' && !record.mirrorId) return
      try {
        const mirror = await this.callWithRetry(scope, epoch, () => this.send(record.mirrorId, operation, this.controller.signal))
        if (!this.valid(scope, epoch)) return
        await this.mutate(scope, taskId, epoch, async () => {
          const latest = await this.options.store.load(scope, taskId)
          if (!latest) return
          const runId = operation.clientRunId ?? operation.payload.clientRunId
          const acknowledged = operation.kind === 'status' && runId
            ? { confirmedStatusByRun: { ...latest.confirmedStatusByRun, [runId]: this.fingerprint(operation.payload) } } : {}
          const contentIndex = latest.contentIndex ? Object.fromEntries(Object.entries(latest.contentIndex).map(([key, entry]) =>
            [key, operation.kind === 'event' && entry.manifestSequence === operation.sequence ? { ...entry, confirmed: true } : entry])) : undefined
          await this.options.store.save(scope, taskId, { ...latest,
            ...acknowledged, ...(contentIndex ? { contentIndex } : {}),
            ...(operation.kind === 'event' ? { sentEvents: [...(latest.sentEvents ?? []), operation.payload] } : {}),
            mirrorId: mirror?.id ?? latest.mirrorId, retryAt: undefined, retryStatusCode: undefined,
            pending: latest.pending.filter(item => item.id !== operation.id), updatedAt: this.now(),
          })
        }, true)
      } catch (error) {
        if (!this.valid(scope, epoch)) return
        // The record's run is the latest admitted run. Only an explicitly older status
        // can be discarded on 409; current/unknown-run conflicts remain pending.
        const operationRun = operation.clientRunId ?? operation.payload.clientRunId
        if (error instanceof ClientMonitorApiError && error.statusCode === 409 && operation.kind === 'status' && operationRun && operationRun !== record.clientRunId && !record.liveRuns?.[operationRun]) {
          await this.mutate(scope, taskId, epoch, async () => {
            const latest = await this.options.store.load(scope, taskId)
            if (latest) await this.options.store.save(scope, taskId, { ...latest,
              pending: latest.pending.filter(item => item.id !== operation.id),
              skippedOldStatusCount: (latest.skippedOldStatusCount ?? 0) + 1, updatedAt: this.now(),
            })
          }, true)
          log.info('client monitor obsolete run status conflict skipped', { taskId, kind: operation.kind })
          continue
        }
        const code = error instanceof ClientMonitorApiError ? error.statusCode : 0
        const delay = error instanceof ClientMonitorApiError ? error.retryAfterMs : undefined
        const retryAt = this.now() + Math.max(delay ?? 30_000, 1000)
        if (code === 429) this.blockedUntil = Math.max(this.blockedUntil, retryAt)
        await this.mutate(scope, taskId, epoch, async () => {
          const latest = await this.options.store.load(scope, taskId)
          if (latest) await this.options.store.save(scope, taskId, { ...latest, retryAt, retryStatusCode: code })
        }, true)
        // Only allowlisted metadata: never arbitrary remote error text or message bodies.
        log.warn('client monitor pending operation retained', { taskId, kind: operation.kind, statusCode: code })
        return
      }
    }
  }

  private async callWithRetry<T>(scope: TaskOwnerScope, epoch: number, send: () => Promise<T>): Promise<T> {
    const signal = this.controller.signal
    for (let attempt = 1; ; attempt++) {
      if (!this.valid(scope, epoch)) throw new Error('Monitor scope changed')
      const pacing = Math.max(0, this.lastSentAt + (this.options.minSendIntervalMs ?? 1000) - this.now())
      if (pacing) await this.abortable(this.sleep(pacing), signal)
      if (!this.valid(scope, epoch)) throw new Error('Monitor scope changed')
      try {
        this.lastSentAt = this.now()
        return await this.abortable(send(), signal)
      } catch (error) {
        if (!this.valid(scope, epoch) || !(error instanceof ClientMonitorApiError) || !error.isRetryable || error.statusCode === 429 || attempt >= this.maxAttempts) throw error
        await this.abortable(this.sleep(Math.min(30_000, Math.max(error.retryAfterMs ?? 0, 250 * 2 ** (attempt - 1)))), signal)
      }
    }
  }

  private async abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted()
    let abort!: () => void
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new Error('Monitor stopped'))
      signal.addEventListener('abort', abort, { once: true })
    })
    try { return await Promise.race([promise, cancelled]) }
    finally { signal.removeEventListener('abort', abort) }
  }

  private send(mirrorId: string | null, operation: ClientMonitorOperation, signal: AbortSignal): Promise<{ id: string } | void> {
    if (operation.kind === 'create') return this.options.api.createTask(operation.payload, signal)
    // Missing historical run IDs stay missing; never silently reattribute to the latest run.
    const payload = operation.clientRunId ? { ...operation.payload, clientRunId: operation.clientRunId } : operation.payload
    if (operation.kind === 'status') return this.options.api.updateStatus(mirrorId!, payload as ClientTaskStatusRequest, signal)
    if (operation.kind === 'heartbeat') return this.options.api.sendHeartbeat(mirrorId!, operation.clientRunId ? { ...operation.payload, clientRunId: operation.clientRunId } : operation.payload, signal)
    return this.options.api.sendEvent(mirrorId!, operation.clientRunId ? { ...operation.payload, clientRunId: operation.clientRunId } : operation.payload, signal)
  }
}
