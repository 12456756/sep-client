import React from 'react'
import { Brain, CheckCircle2, ChevronRight, LoaderCircle, RotateCcw, Wrench, XCircle } from 'lucide-react'
import type { ConversationProcessEntry } from '../../features/enterprise/conversation-transcript'

export const ConversationProcessView = React.memo(function ConversationProcessView({ entries, active, loading, error, onReload }: {
  entries: readonly ConversationProcessEntry[]
  active: boolean
  loading: boolean
  error: string | null
  onReload: () => void
}) {
  const tools = entries.filter(entry => entry.kind === 'tool').length
  const thinking = entries.some(entry => entry.kind === 'thinking')
  const latest = entries.at(-1)
  const status = active
    ? latest?.kind === 'tool' && latest.state === 'running' ? `正在${latest.text}` : latest?.kind === 'thinking' ? '正在思考' : '正在进行…'
    : loading ? '正在读取' : tools ? `${tools} 次工具操作` : thinking ? '思考记录' : '暂无过程记录'
  return <details className="ent-conversation-process" aria-label="工作过程">
    <summary><ChevronRight size={14} className="ent-conversation-process-chevron" aria-hidden /><Brain size={14} aria-hidden />
      <span>工作过程</span><small>{status}</small>
    </summary>
    <div className="ent-conversation-process-body">
      {error ? <div className="ent-conversation-process-error" role="status">工作过程暂时无法读取
        <button type="button" className="ent-icon-btn" aria-label="重新读取工作过程" title="重新读取工作过程" onClick={onReload}><RotateCcw size={14} aria-hidden /></button>
      </div> : null}
      {entries.map(entry => {
          if (entry.kind === 'thinking') return <details key={entry.id} className="ent-conversation-thinking">
            <summary><Brain size={13} aria-hidden />思考过程</summary><p>{entry.text}</p>
          </details>
          const state = entry.kind === 'tool' && entry.state === 'running' && !active ? 'interrupted' : entry.state
          const Icon = state === 'completed' ? CheckCircle2 : state === 'failed' ? XCircle : state === 'running' ? LoaderCircle : Wrench
          return <div key={entry.id} className={`ent-conversation-operation ${state ?? ''}`}>
            <Icon size={14} className={state === 'running' ? 'ent-spin' : undefined} aria-hidden />
            <span>{entry.text}{entry.toolName ? <code>{entry.toolName}</code> : null}</span>
            <small>{state === 'completed' ? '已完成' : state === 'failed' ? '失败' : state === 'running' ? '进行中' : state === 'interrupted' ? '已中断' : ''}</small>
          </div>
      })}
      {!entries.length ? <p className="ent-conversation-process-empty">{active ? '正在进行…' : loading ? '正在读取工作过程…' : '暂无可展示的执行过程'}</p> : null}
    </div>
  </details>
})
