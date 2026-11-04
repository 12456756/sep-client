import type { ResolvedAttachmentInput } from './attachment-input'
import type { VideoHostTools } from './video-tools'

/** Connect conversation inputs to the existing task-owned video host. */
export interface ConversationMediaPort {
  prepareRun(input: {
    taskId: string
    runId: string
    attachments: readonly ResolvedAttachmentInput[]
    signal: AbortSignal
    video: VideoHostTools
  }): Promise<VideoHostTools>
}
