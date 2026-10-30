import type { MediaToolName } from '../../src/shared/media'
import type { ToolAuthorizationRequest } from '../../src/shared/types'
import type { EmployeeRuntimeConfig, TaskToolPolicy } from '../runtime/run-types'

export type { MediaToolName } from '../../src/shared/media'

export interface MediaJobCreated {
  kind: 'image' | 'video'
  jobId: string
  operation: 'generate' | 'edit' | 'image-to-video' | 'text-to-video'
  localAssetIds: readonly string[]
}

/** Trusted task-scoped facade; generation approval happens after quote validation. */
export interface MediaHostTools {
  names: readonly MediaToolName[]
  execute(name: MediaToolName, input: unknown, signal?: AbortSignal): Promise<unknown>
}

export interface MediaRunPort {
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
  }): Promise<MediaHostTools | undefined>
  waitForRun(taskId: string, runId: string, options?: { recoverOriginal?: boolean; signal?: AbortSignal }): Promise<void>
  stopTask(taskId: string): Promise<void>
  resume?(taskId: string, jobId: string): Promise<void>
}
