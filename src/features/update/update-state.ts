import { z } from 'zod'
import type { UpdateState } from '../../shared/ipc'

export type UpdateOperation = 'check' | 'download' | 'cancel' | 'install'
export type UpdateRelease = { version: string; releaseDate: string | null; releaseNotes: string[] }

export const updateErrorMessages: Record<UpdateOperation, string> = {
  check: '检查更新失败，请稍后重试；开发环境或当前平台可能不支持自动更新。',
  download: '下载更新失败，请检查网络后重试。',
  cancel: '取消下载失败，请稍后重试。',
  install: '安装更新失败，请确认运行、排队或待审批的任务已结束后重试。',
}
export const updateSnapshotError = '无法获取更新状态，请稍后重新检查更新。'

const version = z.string().max(100).regex(/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/)
const base = { currentVersion: version }
const nonnegative = z.number().finite().nonnegative()
const updateStateSchema = z.discriminatedUnion('status', [
  z.object({ ...base, status: z.literal('idle') }),
  z.object({ ...base, status: z.literal('checking') }),
  z.object({
    ...base, status: z.literal('available'), version,
    releaseDate: z.iso.datetime({ offset: true }).nullable(),
    releaseNotes: z.array(z.string().max(300)).max(20),
  }),
  z.object({
    ...base, status: z.literal('downloading'), version,
    percent: z.number().finite(), transferred: nonnegative, total: nonnegative, bytesPerSecond: nonnegative,
  }),
  z.object({ ...base, status: z.literal('downloaded'), version }),
  z.object({ ...base, status: z.literal('not-available'), checkedAt: z.iso.datetime({ offset: true }) }),
  z.object({
    ...base, status: z.literal('error'), operation: z.enum(['check', 'download', 'cancel', 'install']),
    message: z.string(), retryable: z.boolean(),
  }),
])

/** Strip unknown fields and replace every IPC error message before it enters UI state. */
export function parseUpdateState(value: unknown): UpdateState | null {
  const result = updateStateSchema.safeParse(value)
  if (!result.success) return null
  const state = result.data
  return state.status === 'error' ? { ...state, message: updateErrorMessages[state.operation] } : state
}

export function canUpdate(state: UpdateState | null, operation: UpdateOperation): boolean {
  switch (operation) {
    case 'check':
      return state === null || ['idle', 'available', 'not-available'].includes(state.status) ||
        (state.status === 'error' && state.retryable)
    case 'download':
      return state?.status === 'available' ||
        (state?.status === 'error' && state.operation === 'download' && state.retryable)
    case 'cancel': return state?.status === 'downloading'
    case 'install': return state?.status === 'downloaded'
  }
}

/** Only presentation numbers are projected; status always comes from the main process. */
export function projectUpdateState(state: UpdateState, previous: UpdateState | null): UpdateState {
  if (state.status !== 'downloading') return state
  const sameDownload = previous?.status === 'downloading' && previous.version === state.version &&
    previous.currentVersion === state.currentVersion
  return {
    ...state,
    percent: Math.max(sameDownload ? previous.percent : 0, Math.min(100, Math.max(0, state.percent))),
    transferred: Math.max(sameDownload ? previous.transferred : 0, state.transferred),
  }
}

export function projectUpdateRelease(state: UpdateState, previous: UpdateRelease | null): UpdateRelease | null {
  if (state.status === 'available') {
    return { version: state.version, releaseDate: state.releaseDate, releaseNotes: [...state.releaseNotes] }
  }
  if (state.status === 'downloading' || state.status === 'downloaded') {
    return previous?.version === state.version ? previous : null
  }
  // Download retries have no version in their error snapshot. A subsequent versioned snapshot verifies the cache.
  if (state.status === 'error' && state.operation !== 'check') return previous
  return null
}
