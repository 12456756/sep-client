import type { MediaToolName } from '../../src/shared/media'
import type { ToolAuthorizationRequest } from '../../src/shared/types'
import type { EmployeeRuntimeConfig, TaskToolPolicy } from '../runtime/run-types'

export type { MediaToolName } from '../../src/shared/media'

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
  }): Promise<MediaHostTools | undefined>
  waitForRun(taskId: string, runId: string): Promise<void>
  stopTask(taskId: string): Promise<void>
}
