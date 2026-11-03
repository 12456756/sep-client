import React, { useMemo } from 'react'
import { LoaderCircle, Paperclip } from 'lucide-react'
import type { SiliconEmployee, WorkItem, WorkMessage } from '../../features/enterprise/types'
import { useArrangementTranscript } from '../../features/enterprise/use-arrangement-transcript'
import { buildConversationReplies, buildConversationTranscript, type ConversationRunTranscript } from '../../features/enterprise/conversation-transcript'
import { ConversationProcessView } from './ConversationProcess'
import { EmployeeFace } from './EmployeeFace'
import { MessageContent } from './MessageContent'

interface Props {
  work: WorkItem
  employees: SiliconEmployee[]
  scopeKey: string
  preparing: boolean
}

export const ConversationMessages = React.memo(function ConversationMessages({ work, employees, scopeKey, preparing }: Props) {
  const transcript = useArrangementTranscript(work.id, scopeKey)
  const runs = useMemo(() => buildConversationTranscript(transcript.events), [transcript.events])
  return <ConversationMessagesView work={work} employees={employees} preparing={preparing} runs={runs}
    loading={transcript.loading} error={transcript.error} onReload={transcript.reload} />
})

export function ConversationMessagesView({ work, employees, preparing, runs, loading, error, onReload }: Omit<Props, 'scopeKey'> & {
  runs: readonly ConversationRunTranscript[]
  loading: boolean
  error: string | null
  onReload: () => void
}) {
  const items = buildConversationReplies(work, preparing)
  const byRun = new Map(runs.map(run => [run.runId, run.entries]))
  const lastReply = [...items].reverse().find(item => item.kind === 'reply')
  return <>{items.map(item => {
    if (item.kind === 'message') {
      const message = item.message
      if (message.role === 'system') return <p className="ent-talk-sys" key={item.id}>{message.content}</p>
      return <div className="ent-say user" key={item.id}>
        <p>{message.content}</p>
        {message.attachments?.length ? <div className="ent-message-attachments" aria-label="本轮附件">{message.attachments.map(attachment => <span key={attachment.attachmentId} title={`${attachment.mediaType} · ${attachment.sha256.slice(0, 12)}`}>
          <Paperclip size={12} aria-hidden />{attachment.displayName}<small>{formatAttachmentBytes(attachment.byteLength)}</small>
        </span>)}</div> : null}
        <MessageTime message={message} />
      </div>
    }
    const first = item.messages[0]
    const employeeId = first?.employeeId || work.currentEmployeeId
    const employeeName = first?.employeeName || work.currentEmployeeName
    const entries = item.runId ? byRun.get(item.runId) ?? [] : []
    const hasContent = item.messages.some(message => message.content.trim())
    const processError = item.id === lastReply?.id ? error : null
    return <div className="ent-say ent-conversation-reply" key={item.id} data-conversation-reply={item.id} data-run-id={item.runId}>
      <span className="ent-say-who"><EmployeeFace employee={employees.find(employee => employee.id === employeeId)} name={employeeName} size="sm" round />{employeeName}</span>
      {item.runId && (entries.length > 0 || loading || processError) ? <ConversationProcessView entries={entries} active={item.active} loading={loading} error={processError} onReload={onReload} /> : null}
      {!hasContent && (!entries.length || !item.active) ? <div className="ent-conversation-reply-status" role="status">
        {item.active ? <LoaderCircle size={14} className="ent-spin" aria-hidden /> : null}
        {item.active ? '正在进行…' : '本轮未返回回复'}
      </div> : null}
      {item.messages.filter(message => message.content.trim()).map(message => <MessageContent key={message.id} content={message.content} />)}
      <MessageTime message={{ createdAt: first?.createdAt ?? item.createdAt }} />
    </div>
  })}</>
}

function MessageTime({ message }: { message: Pick<WorkMessage, 'createdAt'> }) {
  return <time className="ent-message-time" dateTime={new Date(message.createdAt).toISOString()}>
    {new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
  </time>
}

function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
