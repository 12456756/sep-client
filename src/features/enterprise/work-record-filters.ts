import type { AppRoute, WorkItem } from './types'

type RecordsRoute = Extract<AppRoute, { name: 'records' }>
export type WorkRecordFilterState = Required<Omit<RecordsRoute, 'name'>>
export type WorkRecordBucket = WorkRecordFilterState['bucket']
export type WorkRecordTypeFilter = WorkRecordFilterState['workType']
export type WorkRecord = Pick<WorkItem,
  'title' | 'goal' | 'currentEmployeeName' | 'status' | 'nextUserAction' | 'updatedAt' | 'workType'>

const BUCKET_MATCHERS: Record<WorkRecordBucket, (work: WorkRecord) => boolean> = {
  all: () => true,
  active: work => work.status === 'running' || work.status === 'arranging',
  mine: work => work.status === 'waiting-user' || Boolean(work.nextUserAction),
  done: work => work.status === 'completed',
  stopped: work => work.status === 'failed' || work.status === 'paused',
}

export function readWorkRecordFilters(route: AppRoute): WorkRecordFilterState {
  return {
    bucket: route.name === 'records' ? route.bucket ?? 'mine' : 'mine',
    workType: route.name === 'records' ? route.workType ?? 'all' : 'all',
    search: route.name === 'records' ? route.search ?? '' : '',
  }
}

export function resetWorkRecordFilters(): WorkRecordFilterState {
  return { bucket: 'all', workType: 'all', search: '' }
}

function typeMatches(work: WorkRecord, workType: WorkRecordTypeFilter): boolean {
  return workType === 'all' || (work.workType.state === 'resolved' && work.workType.kind === workType)
}

function searchMatches(work: WorkRecord, keyword: string): boolean {
  return !keyword || `${work.title} ${work.goal} ${work.currentEmployeeName}`.includes(keyword)
}

export function filterWorkRecords<T extends WorkRecord>(records: readonly T[], filters: WorkRecordFilterState): T[] {
  const keyword = filters.search.trim()
  return records
    .filter(work => BUCKET_MATCHERS[filters.bucket](work) && typeMatches(work, filters.workType) && searchMatches(work, keyword))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function countWorkRecordStatuses(records: readonly WorkRecord[], filters: WorkRecordFilterState): Record<WorkRecordBucket, number> {
  const counts: Record<WorkRecordBucket, number> = { all: 0, active: 0, mine: 0, done: 0, stopped: 0 }
  const buckets: WorkRecordBucket[] = ['all', 'active', 'mine', 'done', 'stopped']
  const keyword = filters.search.trim()
  for (const work of records) {
    if (!typeMatches(work, filters.workType) || !searchMatches(work, keyword)) continue
    for (const bucket of buckets) {
      if (BUCKET_MATCHERS[bucket](work)) counts[bucket] += 1
    }
  }
  return counts
}

export function countWorkRecordTypes(records: readonly WorkRecord[], filters: WorkRecordFilterState): Record<WorkRecordTypeFilter, number> {
  const counts: Record<WorkRecordTypeFilter, number> = { all: 0, conversation: 0, arrangement: 0 }
  const keyword = filters.search.trim()
  for (const work of records) {
    if (!BUCKET_MATCHERS[filters.bucket](work) || !searchMatches(work, keyword)) continue
    counts.all += 1
    if (work.workType.state === 'resolved') counts[work.workType.kind] += 1
  }
  return counts
}

export function countUnresolvedWorkRecordTypes(records: readonly WorkRecord[], filters: WorkRecordFilterState): { loading: number; unavailable: number } {
  const counts = { loading: 0, unavailable: 0 }
  const keyword = filters.search.trim()
  for (const work of records) {
    if (!BUCKET_MATCHERS[filters.bucket](work) || !searchMatches(work, keyword)) continue
    if (work.workType.state !== 'resolved') counts[work.workType.state] += 1
  }
  return counts
}
