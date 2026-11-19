export type MediaRetryState = 'checking' | 'clear' | 'unavailable' | 'unconfirmed'
export interface MediaJobSummary { outputs: number | null; error: string | null; retryState: MediaRetryState }

export const MEDIA_REPLAY_BLOCKED = '媒体提交结果尚未确认。请在「产出结果」中查看原任务，勿重复提交。'
export const MEDIA_RETRY_READ_FAILED = '暂时无法核实媒体任务状态。请在「产出结果」中查看原任务，核实前请勿重复提交。'

export function mediaRetryNotice(state: MediaRetryState): string | null {
  if (state === 'unconfirmed') return MEDIA_REPLAY_BLOCKED
  if (state === 'unavailable') return MEDIA_RETRY_READ_FAILED
  return state === 'checking' ? '正在核实媒体任务状态…' : null
}

export function isMediaSubmissionUnconfirmed(status: string | undefined): boolean {
  return status === 'SUBMITTING' || status === 'SUBMISSION_UNKNOWN'
}

export function mediaRetryState(statuses: readonly string[], loaded: boolean, failed: boolean): MediaRetryState {
  if (statuses.some(isMediaSubmissionUnconfirmed)) return 'unconfirmed'
  if (failed) return 'unavailable'
  return loaded ? 'clear' : 'checking'
}
