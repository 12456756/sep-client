import type { ResolvedAttachmentInput } from './attachment-input'
import type { VideoHostTools } from './video-tools'
import type { MediaHostTools } from './media-tools'

/** Connect conversation inputs to task-owned image and video hosts independently. */
export interface ConversationMediaPort {
  prepareRun(input: {
    taskId: string
    runId: string
    attachments: readonly ResolvedAttachmentInput[]
    historicalAttachments?: readonly ResolvedAttachmentInput[]
    signal: AbortSignal
    media?: MediaHostTools
    video?: VideoHostTools
  }): Promise<{ media?: MediaHostTools; video?: VideoHostTools }>
}
