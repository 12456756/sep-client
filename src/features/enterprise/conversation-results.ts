import type { ResultFileRequest } from '../../shared/result-files'
import type { VideoTaskView } from '../../shared/video-host'
import type { ConversationReplyItem } from './conversation-transcript'
import type { WorkDeliverable, WorkItem } from './types'

export interface ConversationResult {
  file: WorkDeliverable
  request?: ResultFileRequest
  runId?: string
  createdAt?: number
}

export function savedConversationVideos(taskId: string, view: VideoTaskView): ConversationResult[] {
  const seen = new Set<string>()
  return view.jobs.filter(job => job.taskId === taskId).flatMap(job => job.outputs.flatMap((output, index) => {
    const key = `${job.jobId}:${output.outputId}`
    const saved = job.savedOutputIds === undefined ? job.saveStatus === 'SAVED' : job.savedOutputIds.includes(output.outputId)
    if (!saved || seen.has(key)) return []
    seen.add(key)
    const format = output.mimeType.split('/')[1]
    return [{ file: { id: key, name: `视频成果${index + 1}.${format}`, format, path: '', note: '', previewVersion: output.sha256,
      sourceArtifact: { kind: 'video' as const, artifactId: output.outputId, sha256: output.sha256 } },
    request: { taskId, jobId: job.jobId, outputId: output.outputId }, createdAt: job.createdAt }]
  }))
}

/** Only registered task files become cards; reply text is used for placement, never file access. */
export function groupConversationResults(work: WorkItem, items: ConversationReplyItem[], media: ConversationResult[]): Map<string, ConversationResult[]> {
  const replies = items.filter(item => item.kind === 'reply')
  const groups = new Map<string, ConversationResult[]>()
  const append = (replyId: string | undefined, result: ConversationResult) => {
    const key = replyId ?? 'unassigned'
    groups.set(key, [...(groups.get(key) ?? []), result])
  }
  const seen = new Set<string>()
  for (const file of work.deliverables ?? []) {
    const key = file.path.replace(/\\/g, '/') || file.id
    if (seen.has(key)) continue
    seen.add(key)
    const mentions = replies.filter(reply => reply.messages.some(message => message.content.includes(file.path || file.name) || message.content.includes(file.name)))
    const owner = mentions.at(-1) ?? replies.find(reply => reply.runId === work.lastRunId)
      ?? replies.filter(reply => !reply.active).at(-1) ?? replies.at(-1)
    append(owner?.id, { file })
  }
  for (const result of media) {
    const key = JSON.stringify(result.request)
    if (seen.has(key)) continue
    seen.add(key)
    const createdAt = result.createdAt
    const owner = result.runId ? replies.find(reply => reply.runId === result.runId)
      : createdAt !== undefined ? replies.filter(reply => reply.createdAt <= createdAt).at(-1)
        : replies.filter(reply => !reply.active).at(-1) ?? replies.at(-1)
    append(owner?.id, result)
  }
  return groups
}
