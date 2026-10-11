import { z } from 'zod'
import type { ElectronAPI } from '../../shared/ipc'

const taskCountsSchema = z.object({
  running: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  pending: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  waitingApproval: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
})
const taskResultSchema = z.object({ success: z.literal(true), stats: taskCountsSchema })

export type UpdateTaskStatus =
  | { status: 'checking' }
  | { status: 'ready' }
  | { status: 'blocked'; running: number; pending: number; waitingApproval: number }
  | { status: 'error' }

// This snapshot explains the confirmation. Main rechecks tasks before installation.
export async function readUpdateTaskStatus(api: Pick<ElectronAPI, 'getTaskStats'>): Promise<UpdateTaskStatus> {
  try {
    const result = await api.getTaskStats()
    const parsed = taskResultSchema.safeParse(result)
    if (!parsed.success) return { status: 'error' }
    const counts = parsed.data.stats
    return counts.running + counts.pending + counts.waitingApproval > 0
      ? { status: 'blocked', ...counts }
      : { status: 'ready' }
  } catch {
    return { status: 'error' }
  }
}
