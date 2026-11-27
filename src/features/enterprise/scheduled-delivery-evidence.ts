import { z } from 'zod'
import type { TaskExecutionEvent } from '../../shared/types'

const tool = 'dingtalk_execute'
const text = z.string().min(1).max(512).regex(/^[^\p{Cc}\p{Bidi_Control}]+$/u)
const eventData = z.record(z.string(), z.unknown())
const size = z.number().int().positive().safe()
const attachment = z.object({ name: text, path: text, sizeBytes: size })
const contact = z.object({ success: z.literal(true), result: z.tuple([z.object({ name: text, openDingTalkId: text })]) })
const send = z.object({ ok: z.literal(true), effectiveMessageType: z.literal('file'), file: attachment,
  sendReceipt: z.object({ openTaskId: text }), result: z.object({ success: z.literal(true), result: z.object({ openTaskId: text }) }) })
const status = z.object({ openTaskId: text, success: z.literal(true), readyForMessageActions: z.literal(true),
  result: z.object({ sendStatus: z.literal('SUCCESS'), openConversationId: text, openMessageId: text }) })
const dwsMessage = z.object({ role: z.literal('toolResult'), toolName: z.literal(tool), toolCallId: text, isError: z.literal(false),
  details: z.object({ serverName: z.literal('dingtalk'), toolName: z.literal(tool), isError: z.literal(false) }),
  content: z.tuple([z.object({ type: z.literal('text'), text: z.string().max(128_000) })]) })

function flag(args: string[], key: string): string | undefined {
  const values = args.flatMap((arg, index) => arg === key ? [args[index + 1]] : arg.startsWith(`${key}=`) ? [arg.slice(key.length + 1)] : [])
  const value = values.length === 1 && text.safeParse(values[0]).data
  return value && !value.startsWith('--') ? value : undefined
}

type Entry = { id: string } & (
  { kind: 'contact-call'; target: string } | { kind: 'contact-result'; target: string; recipient: string }
  | { kind: 'send-call'; recipient: string; path: string } | { kind: 'send-result'; openTaskId: string; file: z.infer<typeof attachment> }
  | { kind: 'status-call' | 'status-result'; openTaskId: string }
)

function projectEntry(event: TaskExecutionEvent): Entry | undefined {
  if (event.type !== 'tool_execution_start' && event.type !== 'message_end') return
  const data = eventData.safeParse(event.data).data
  if (!data) return
  if (event.type === 'tool_execution_start' && data.toolName === tool) {
    const id = text.safeParse(data.toolId).data
    const args = z.object({ args: z.array(z.string()).max(128) }).safeParse(data.input).data?.args
    if (!id || !args) return
    if (args[0] === 'contact' && args[1] === 'user' && args[2] === 'search') {
      const target = flag(args.slice(3), '--query')
      if (target) return { id, kind: 'contact-call', target }
    }
    if (args[0] !== 'chat') return
    const flags = args.slice(2)
    if (args[1] === '+messages-send' && flag(flags, '--msg-type') === 'file' && flag(flags, '--as') === 'user' &&
      !flags.some(arg => /^--(?:user|conversation-id|group|robot-code|webhook|jq|fields)(?:=|$)/.test(arg))) {
      const recipient = flag(flags, '--open-dingtalk-id')
      const path = flag(flags, '--file')
      if (recipient && path) return { id, kind: 'send-call', recipient, path }
    }
    if (args[1] === '+messages-query-send-status') {
      const openTaskId = flag(flags, '--open-task-id')
      if (openTaskId) return { id, kind: 'status-call', openTaskId }
    }
    return
  }
  if (event.type !== 'message_end') return
  const message = dwsMessage.safeParse(data.message).data
  if (!message) return
  const id = message.toolCallId
  let result: unknown
  try { result = JSON.parse(message.content[0].text) } catch { return }
  const person = contact.safeParse(result).data?.result[0]
  if (person) return { id, kind: 'contact-result', target: person.name, recipient: person.openDingTalkId }
  const sent = send.safeParse(result).data
  if (sent && sent.sendReceipt.openTaskId === sent.result.result.openTaskId) {
    return { id, kind: 'send-result', openTaskId: sent.sendReceipt.openTaskId, file: sent.file }
  }
  const confirmed = status.safeParse(result).data
  if (confirmed) return { id, kind: 'status-result', openTaskId: confirmed.openTaskId }
}

/** Keep only receipt fields needed for matching, not full connector output or message bodies. */
type DeliveryEvent = TaskExecutionEvent & { data: { entry: Entry } }

export function selectScheduledDeliveryEvent(event: TaskExecutionEvent): DeliveryEvent | null {
  try {
    const entry = projectEntry(event)
    return entry ? { ...event, data: { entry } } : null
  } catch { return null }
}

export interface ScheduledAttachmentEvidence {
  tool: string
  action: string
  target: string
  nodeRunId: string
  path: string
  size: number
}

export function scheduledAttachmentEvidence(events: readonly DeliveryEvent[], taskId: string): ScheduledAttachmentEvidence[] {
  const calls = new Map<string, Entry>()
  const recipients = new Map<string, Map<string, Set<string>>>()
  const submitted = new Map<string, { recipient: string; sequence: number; file: z.infer<typeof attachment> }>()
  const checked = new Map<string, number>()
  const normalizePath = (path: string) => path.replaceAll('\\', '/').replace(/^\.\//, '')
  for (const event of events.filter(event => event.taskId === taskId).sort((a, b) => a.sequence - b.sequence)) {
    const { entry } = event.data
    const callKey = JSON.stringify([event.runId, entry.id])
    if (entry.kind === 'contact-call' || entry.kind === 'send-call' || entry.kind === 'status-call') {
      calls.set(callKey, entry)
      continue
    }
    const call = calls.get(callKey)
    calls.delete(callKey)
    if (entry.kind === 'contact-result' && call?.kind === 'contact-call' && entry.target === call.target) {
      const names = recipients.get(event.runId) ?? new Map<string, Set<string>>()
      const ids = names.get(entry.target) ?? new Set<string>()
      ids.add(entry.recipient); names.set(entry.target, ids); recipients.set(event.runId, names)
    }
    if (entry.kind === 'send-result' && call?.kind === 'send-call' && normalizePath(entry.file.path) === normalizePath(call.path)
      && normalizePath(call.path).split('/').at(-1) === entry.file.name) {
      submitted.set(JSON.stringify([event.runId, entry.openTaskId]), { recipient: call.recipient, file: entry.file, sequence: event.sequence })
    }
    if (entry.kind === 'status-result' && call?.kind === 'status-call' && entry.openTaskId === call.openTaskId) {
      checked.set(JSON.stringify([event.runId, entry.openTaskId]), event.sequence)
    }
  }
  return [...submitted].flatMap(([key, submitted]) => {
    if ((checked.get(key) ?? 0) <= submitted.sequence) return []
    const [nodeRunId] = JSON.parse(key) as [string, string]
    return [...(recipients.get(nodeRunId) ?? [])].flatMap(([target, ids]) => ids.size === 1 && ids.has(submitted.recipient)
      ? [{ tool, action: 'chat +messages-send', target, nodeRunId, path: normalizePath(submitted.file.path), size: submitted.file.sizeBytes }] : [])
  })
}
