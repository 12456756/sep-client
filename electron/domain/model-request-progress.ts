import { z } from 'zod'

export const modelRequestProgressSchema = z.object({
  executionRounds: z.number().int().nonnegative().safe(),
  // Allocated before provider I/O; this is not a billing or completed-request count.
  requestAttempts: z.number().int().nonnegative().safe(),
  executionRetries: z.number().int().nonnegative().safe(),
  compactionAttempts: z.number().int().nonnegative().safe(),
  // Absent means complete node counts; legacy sessions can only count from recovery onward.
  countingScope: z.literal('since-resume').optional(),
}).strict().refine(value => value.requestAttempts === value.executionRounds + value.executionRetries + value.compactionAttempts)

export type ModelRequestProgress = z.infer<typeof modelRequestProgressSchema>
export type ModelRequestKind = 'execution' | 'retry' | 'recovery' | 'compaction'

const EMPTY_MODEL_REQUEST_PROGRESS: ModelRequestProgress = {
  executionRounds: 0,
  requestAttempts: 0,
  executionRetries: 0,
  compactionAttempts: 0,
}

export function advanceModelRequestProgress(
  previous: ModelRequestProgress | undefined,
  kind: ModelRequestKind,
  initialCountingScope?: ModelRequestProgress['countingScope'],
): ModelRequestProgress {
  const current = previous ?? { ...EMPTY_MODEL_REQUEST_PROGRESS, ...(initialCountingScope ? { countingScope: initialCountingScope } : {}) }
  if (!modelRequestProgressSchema.safeParse(current).success) throw new Error('模型请求计数状态无效。')
  if ((kind === 'retry' || kind === 'recovery') && current.executionRounds === 0) {
    throw new Error('模型请求重试不能发生在首次执行请求之前。')
  }
  return modelRequestProgressSchema.parse({
    executionRounds: current.executionRounds + (kind === 'execution' ? 1 : 0),
    requestAttempts: current.requestAttempts + 1,
    executionRetries: current.executionRetries + (kind === 'retry' || kind === 'recovery' ? 1 : 0),
    compactionAttempts: current.compactionAttempts + (kind === 'compaction' ? 1 : 0),
    ...(current.countingScope ? { countingScope: current.countingScope } : {}),
  })
}
