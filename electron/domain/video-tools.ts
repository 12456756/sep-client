import type { ToolAuthorizationRequest } from '../../src/shared/types'
import type { EmployeeRuntimeConfig, TaskToolPolicy } from '../runtime/run-types'
import type { MediaJobCreated } from './media-tools'

/** V0 deliberately excludes cancellation until the video host supports it. */
export type VideoToolName = 'video_from_image' | 'video_generate' | 'video_get_job'

/** Trusted task-scoped facade; the host validates quotes and obtains approval. */
export interface VideoHostTools {
  names: readonly VideoToolName[]
  execute(name: VideoToolName, input: unknown, signal?: AbortSignal): Promise<unknown>
}

/** Run lifecycle stays host-owned, independent of Pi sessions and IPC. */
export interface VideoRunPort {
  prepareRun(input: {
    taskId: string
    runId: string
    subscriptionId: string
    employee: EmployeeRuntimeConfig
    toolPolicy?: TaskToolPolicy
    requestApproval: (input: Omit<ToolAuthorizationRequest, 'requestId' | 'timestamp'>) => Promise<boolean>
    /** Persist the node association before the first generation submission. */
    onJobCreated?: (job: MediaJobCreated) => Promise<void>
    recoverJobIds?: readonly string[]
    /** Arrangement media operations are already inside the user's approved run. */
    autoApproveMedia?: boolean
    /** Stop the current employee turn after an external media submission failure. */
    onTerminalFailure?: (error: unknown) => void | Promise<void>
  }): Promise<VideoHostTools | undefined>
  waitForRun(taskId: string, runId: string): Promise<void>
  stopTask(taskId: string): Promise<void>
  finishRun?(taskId: string, runId: string): Promise<void>
}
