import { z } from 'zod'
import type { TaskExecutionEvent, ToolAuthorizationRequest } from './types'

export const OFFICE_TOOL_NAME = 'mcp__officecli__officecli'

export const approvalFileName = z.string().min(1).max(120).regex(/^[^/\\:\u202a-\u202e\u2066-\u2069]+$/u)
  .refine(name => [...name].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127))
const browserOrigin = z.string().max(300).refine(value => {
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && value === url.origin
  } catch { return false }
})

export function approvalBrowserOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    const parsed = browserOrigin.safeParse(url.origin)
    return parsed.success ? parsed.data : undefined
  } catch { return undefined }
}

export const toolApprovalSummarySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('office'), operation: z.enum(['edit', 'batch', 'write', 'import-doc', 'export-doc']),
    files: z.array(approvalFileName).min(1).max(3), additionalFiles: z.boolean() }).strict(),
  z.object({ kind: z.literal('browser-navigate'), origin: browserOrigin.optional() }).strict(),
  z.object({ kind: z.literal('browser-click') }).strict(),
  z.object({ kind: z.literal('browser-snapshot'), savesFile: z.boolean() }).strict(),
  z.object({ kind: z.literal('browser-save-assets') }).strict(),
  z.object({ kind: z.literal('dingtalk-message'), targetType: z.enum(['person', 'group']),
    target: z.string().min(1).max(240).regex(/^[^\p{Cc}\p{Bidi_Control}]+$/u),
    body: z.string().min(1).max(64000) }).strict(),
])
export type ToolApprovalSummary = z.infer<typeof toolApprovalSummarySchema>

export const BROWSER_HANDOFF_TIMEOUT_MS = 180_000

export function isBrowserHandoffRequest(request: { toolName: string; input: unknown }): boolean {
  return request.toolName === 'mcp__playwright__browser_set_mode'
    && typeof request.input === 'object' && request.input !== null && !Array.isArray(request.input)
    && 'operation' in request.input && request.input.operation === 'manual-handoff'
}

export function isDetectedBrowserHandoff(request: { toolName: string; input: unknown }): boolean {
  return isBrowserHandoffRequest(request) && typeof request.input === 'object' && request.input !== null
    && 'autoDetect' in request.input && request.input.autoDetect === true
}

export function removeResolvedBrowserHandoff(requests: ToolAuthorizationRequest[], event: TaskExecutionEvent): ToolAuthorizationRequest[] {
  const { data } = event
  if (event.type !== 'approval_resolved' || !data || typeof data !== 'object' || !('requestId' in data) || typeof data.requestId !== 'string') return requests
  const index = requests.findIndex(request => isDetectedBrowserHandoff(request) && request.requestId === data.requestId &&
    request.runId === event.runId && request.taskId === event.taskId)
  return index < 0 ? requests : requests.filter((_, position) => position !== index)
}

export function isMediaResubmissionRequest(request: { toolName: string; input: unknown }): boolean {
  if (!['media_generate_image', 'video_generate', 'video_from_image', 'video_from_video'].includes(request.toolName)
    || typeof request.input !== 'object' || request.input === null || Array.isArray(request.input)) return false
  const input = request.input as Record<string, unknown>
  return input.operation === 'confirm-new-generation' && Number.isSafeInteger(input.unconfirmedJobCount)
    && Number(input.unconfirmedJobCount) > 0
}

export function toolApprovalTimeoutMs(request: { toolName: string; input: unknown }): number {
  return isBrowserHandoffRequest(request) ? BROWSER_HANDOFF_TIMEOUT_MS : 60_000
}
