/** V0 deliberately excludes cancellation until the video host supports it. */
export type VideoToolName = 'video_from_image' | 'video_generate' | 'video_get_job'

/** Trusted task-scoped facade; the host validates quotes and obtains approval. */
export interface VideoHostTools {
  names: readonly VideoToolName[]
  execute(name: VideoToolName, input: unknown, signal?: AbortSignal): Promise<unknown>
}

/** Run lifecycle stays host-owned, independent of Pi sessions and IPC. */
export interface VideoRunPort {
  prepareRun(input: Parameters<import('./media-tools').MediaRunPort['prepareRun']>[0]): Promise<VideoHostTools | undefined>
  waitForRun(taskId: string, runId: string): Promise<void>
  stopTask(taskId: string): Promise<void>
  finishRun?(taskId: string, runId: string): Promise<void>
}
