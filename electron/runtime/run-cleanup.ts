import { describeError } from '../common/redact'
import { logger } from '../common/logger'

const log = logger.child('run-cleanup')

/** A failed cleanup must never skip later ownership/completion releases. */
export async function cleanupRun(
  taskId: string,
  runId: string,
  steps: readonly (readonly [string, () => unknown])[],
): Promise<void> {
  for (const [stage, cleanup] of steps) {
    try { await cleanup() } catch (error) {
      log.warn('run cleanup failed', { taskId, runId, stage, cause: describeError(error) })
    }
  }
}
