import { planningRecordSummary, type AutoPlanningInput, type PlanningRecordChange, type PlanningRecordSnapshot, type PlanningRecordSummary } from '../../shared/auto-planning'
import type { ArrangementDraft, ArrangementPlanningProgress } from '../../shared/types'
import type { ElectronAPI } from '../../shared/ipc'
import { responseError } from '../../shared/arrangement-feedback'

export class AutoPlanningController {
  private records: PlanningRecordSummary[] = []
  private readonly details = new Map<string, PlanningRecordSnapshot>()
  private readonly buffered = new Map<string, ArrangementPlanningProgress[]>()
  private readonly listeners = new Set<() => void>()
  private readonly detailListeners = new Map<string, Set<() => void>>()
  private readonly loads = new Map<string, Promise<void>>()
  private readonly touched = new Map<string, number>()
  private readonly removed = new Set<string>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly starts = new Map<string, Promise<PlanningRecordSnapshot | null>>()
  private active = false
  private generation = 0
  private counter = 0
  constructor(private readonly owner: ArrangementDraft['owner'], private readonly api: ElectronAPI, private readonly onListError?: (error: unknown) => void) {}
  getRecords = (): PlanningRecordSummary[] => this.records
  getRecord = (id: string): PlanningRecordSnapshot | undefined => this.details.get(id)
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  subscribeRecord = (id: string, listener: () => void): (() => void) => {
    const set = this.detailListeners.get(id) ?? new Set<() => void>()
    this.detailListeners.set(id, set); set.add(listener)
    return () => { set.delete(listener); if (!set.size) this.detailListeners.delete(id) }
  }
  private belongs(owner: ArrangementDraft['owner'] | undefined): boolean {
    return owner?.memberId === this.owner.memberId && owner.enterpriseId === this.owner.enterpriseId
  }
  private emitRecord(id: string, immediate = false): void {
    if (!this.detailListeners.get(id)?.size) return
    const emit = () => { this.timers.delete(id); this.detailListeners.get(id)?.forEach(listener => listener()) }
    if (immediate) { clearTimeout(this.timers.get(id)); emit() }
    else if (!this.timers.has(id)) this.timers.set(id, setTimeout(emit, 80))
  }
  private mergeEvents(events: ArrangementPlanningProgress[]): ArrangementPlanningProgress[] {
    const unique = new Map<string, ArrangementPlanningProgress>()
    for (const event of events) unique.set(`${event.planningId}:${event.sequence ?? `${event.type}:${event.occurredAt}:${event.data.subscriptionId ?? ''}`}`, event)
    return [...unique.values()].sort((a, b) => (a.sequence ?? a.occurredAt) - (b.sequence ?? b.occurredAt)).slice(-128)
  }
  private publishSummary(record: PlanningRecordSummary): void {
    const previous = this.records.find(item => item.id === record.id)
    if (this.removed.has(record.id) || previous && previous.revision >= record.revision) return
    this.records = [...this.records.filter(item => item.id !== record.id), record]
    this.listeners.forEach(listener => listener())
  }
  updateDraft = (draft: ArrangementDraft): void => {
    if (!this.active || !this.belongs(draft.owner) || this.removed.has(draft.id)) return
    const previous = this.details.get(draft.id)
    if (previous && previous.draft.revision > draft.revision) return
    this.touched.set(draft.id, ++this.counter)
    this.details.set(draft.id, { draft, progress: previous?.progress ?? null })
    this.publishSummary(planningRecordSummary(draft))
    this.emitRecord(draft.id, true)
  }
  private applySnapshot(snapshot: PlanningRecordSnapshot): void {
    if (!this.belongs(snapshot.draft.owner) || this.removed.has(snapshot.draft.id)) return
    const id = snapshot.draft.id
    const previous = this.details.get(id)
    const draft = previous && previous.draft.revision > snapshot.draft.revision ? previous.draft : snapshot.draft
    const planningId = draft.lastPlanning?.planningId
    const pending = this.buffered.get(id) ?? []
    const events = this.mergeEvents([...(snapshot.progress?.events ?? []), ...(previous?.progress?.events ?? []), ...pending].filter(event => event.planningId === planningId))
    const source = previous?.progress && previous.progress.planningId === planningId ? previous.progress : snapshot.progress?.planningId === planningId ? snapshot.progress : null
    const progress = source || events.length ? { owner: draft.owner, draftId: id, planningId: planningId ?? '', modelId: source?.modelId ?? draft.planningModelId ?? '',
      sequence: Math.max(source?.sequence ?? 0, ...events.map(event => event.sequence ?? 0)), events } : null
    this.details.set(id, { draft, progress })
    this.buffered.delete(id)
    this.publishSummary(planningRecordSummary(draft))
    this.emitRecord(id, true)
  }
  private onProgress = (event: ArrangementPlanningProgress): void => {
    if (!this.active || !this.belongs(event.owner) || this.removed.has(event.draftId)) return
    const previous = this.details.get(event.draftId)
    if (!previous) {
      this.buffered.set(event.draftId, this.mergeEvents([...(this.buffered.get(event.draftId) ?? []), event]))
      return
    }
    if (previous.draft.lastPlanning?.planningId && previous.draft.lastPlanning.planningId !== event.planningId) {
      if (event.draftRevision <= previous.draft.revision) return
      this.buffered.set(event.draftId, this.mergeEvents([...(this.buffered.get(event.draftId) ?? []), event]))
      return
    }
    const progress = previous.progress
    const events = this.mergeEvents([...(progress?.events ?? []), event])
    this.details.set(event.draftId, { ...previous, progress: { owner: this.owner, draftId: event.draftId, planningId: event.planningId,
      modelId: progress?.modelId ?? previous.draft.planningModelId ?? '', sequence: Math.max(progress?.sequence ?? 0, event.sequence ?? 0), events } })
    this.emitRecord(event.draftId, /completed|failed|cancelled/.test(event.type))
    if (/completed|failed|cancelled/.test(event.type)) void this.load(event.draftId).catch(() => undefined)
  }
  private onChange = (change: PlanningRecordChange): void => {
    if (!this.active || !this.belongs(change.owner)) return
    this.touched.set(change.draftId, ++this.counter)
    if (!change.record) { this.remove(change.draftId); return }
    this.publishSummary(change.record)
    if (this.details.has(change.draftId) || this.detailListeners.has(change.draftId)) void this.load(change.draftId).catch(() => undefined)
  }
  remove = (id: string): void => {
    this.removed.add(id)
    this.touched.set(id, ++this.counter)
    this.records = this.records.filter(item => item.id !== id)
    this.details.delete(id); this.buffered.delete(id)
    this.listeners.forEach(listener => listener()); this.emitRecord(id, true)
  }
  load = (id: string): Promise<void> => {
    const existing = this.loads.get(id)
    if (existing) return existing
    const generation = this.generation
    const marker = this.touched.get(id) ?? 0
    const pending = (async () => {
      const result = await this.api.getPlanningRecord(id)
      if (!this.active || generation !== this.generation) return
      if (!result.success || !result.snapshot) throw responseError(result, 'read')
      this.applySnapshot(result.snapshot)
    })()
    this.loads.set(id, pending)
    void pending.finally(() => {
      if (this.loads.get(id) !== pending) return
      this.loads.delete(id)
      const summary = this.records.find(record => record.id === id)
      if (this.active && generation === this.generation && !this.removed.has(id) && (this.touched.get(id) ?? 0) > marker
        && summary && summary.revision > (this.details.get(id)?.draft.revision ?? 0)) void this.load(id).catch(() => undefined)
    }).catch(() => undefined)
    return pending
  }
  start = (input: AutoPlanningInput): Promise<PlanningRecordSnapshot | null> => {
    const existing = this.starts.get(input.requestId)
    if (existing) return existing
    const generation = this.generation
    const pending = (async () => {
      const result = await this.api.createAndPlanArrangement(input)
      if (!this.active || generation !== this.generation) return null
      if (!result.success || !result.snapshot) throw responseError(result, 'planning')
      this.applySnapshot(result.snapshot)
      return result.snapshot
    })()
    this.starts.set(input.requestId, pending)
    void pending.finally(() => { if (this.starts.get(input.requestId) === pending) this.starts.delete(input.requestId) }).catch(() => undefined)
    return pending
  }
  attach = (): (() => void) => {
    this.active = true
    const generation = ++this.generation
    const marker = this.counter
    const unsubscribeProgress = this.api.onArrangementPlanningEvent(this.onProgress)
    const unsubscribeRecords = this.api.onPlanningRecordChanged(this.onChange)
    void this.api.listPlanningRecords().then(result => {
      if (!this.active || generation !== this.generation) return
      if (!result.success) throw responseError(result, 'read')
      const fresh = (result.records ?? []).filter(record => this.belongs(record.owner) && !this.removed.has(record.id) && (this.touched.get(record.id) ?? 0) <= marker)
      this.records = [...this.records.filter(record => (this.touched.get(record.id) ?? 0) > marker), ...fresh]
      this.listeners.forEach(listener => listener())
    }).catch(error => { if (this.active && generation === this.generation) this.onListError?.(error) })
    return () => {
      if (generation !== this.generation) return
      this.active = false; this.generation++
      unsubscribeProgress(); unsubscribeRecords()
      this.timers.forEach(clearTimeout); this.timers.clear(); this.loads.clear(); this.starts.clear()
    }
  }
}
