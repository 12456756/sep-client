import { ArrowDown, Brain, CheckCircle2, ChevronDown, ChevronRight, FileOutput, LoaderCircle, RotateCcw, StopCircle, Wrench, XCircle } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SiliconEmployee, WorkItem } from '../../../features/enterprise/types'
import { buildArrangementTranscript, type NodeTranscript, type TranscriptEntry } from '../../../features/enterprise/arrangement-transcript'
import { useArrangementTranscript } from '../../../features/enterprise/use-arrangement-transcript'
import { EmployeeFace } from '../EmployeeFace'
import { MessageContent } from '../MessageContent'
import { StepStateChip } from '../atoms'

interface Props {
  work: WorkItem
  employees: SiliconEmployee[]
  scopeKey: string
  busy: boolean
  onStop: (id: string, reason: string) => Promise<boolean>
  onResults: () => void
}

export function ArrangementTranscript(props: Props) {
  const transcript = useArrangementTranscript(props.work.id, props.scopeKey)
  const nodes = useMemo(() => buildArrangementTranscript(props.work.steps, transcript.events), [props.work.steps, transcript.events])
  return <ArrangementTranscriptView {...props} nodes={nodes} loading={transcript.loading} error={transcript.error} onReload={transcript.reload} />
}

export function ArrangementTranscriptView({ work, employees, nodes, loading = false, error = null, onReload, onStop, onResults, busy }: Omit<Props, 'scopeKey'> & {
  nodes: NodeTranscript[]; loading?: boolean; error?: string | null; onReload?: () => void
}) {
  const body = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const [hasNewContent, setHasNewContent] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [reason, setReason] = useState('')
  const active = nodes.filter(node => node.step.state === 'running' || node.step.state === 'waiting-user')
  useEffect(() => {
    if (follow.current && body.current) body.current.scrollTop = body.current.scrollHeight
    else setHasNewContent(true)
  }, [nodes])
  const jump = (nodeId: string) => {
    follow.current = false
    body.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(nodeId)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }
  return <section className="ent-arrangement-transcript" aria-label="编排执行过程">
    <div className="ent-transcript-toolbar">
      <div className="ent-transcript-running" aria-label="正在执行的节点">
        {active.length ? <><LoaderCircle size={14} className="ent-spin" aria-hidden /><span>正在执行</span>
          {active.map(node => <button type="button" key={node.step.id} onClick={() => jump(node.step.id)}>{node.step.title}</button>)}</>
          : <span>{work.status === 'completed' ? '全部工作已完成' : work.status === 'paused' ? '工作已终止' : work.status === 'failed' ? '工作已中断' : '等待执行'}</span>}
      </div>
      {work.isActive ? <button type="button" className="ent-btn sm ghost" disabled={busy} onClick={() => setStopping(value => !value)}><StopCircle size={14} aria-hidden />终止</button> : null}
    </div>
    {stopping ? <div className="ent-transcript-stop" role="group" aria-label="确认终止编排">
      <span>终止后保留已完成的工作和文件。</span>
      <input className="ent-input" aria-label="终止原因" placeholder="终止原因（可留空）" value={reason} onChange={event => setReason(event.target.value)} />
      <button type="button" className="ent-btn sm" onClick={() => setStopping(false)}>取消</button>
      <button type="button" className="ent-btn sm danger" disabled={busy} onClick={() => { void onStop(work.id, reason.trim() || '用户终止了这项工作').then(ok => { if (ok) setStopping(false) }) }}>确认终止</button>
    </div> : null}
    <div className="ent-transcript-body" ref={body} onScroll={() => {
      const el = body.current
      if (!el) return
      follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
      if (follow.current) setHasNewContent(false)
    }}>
      <div className="ent-transcript-content">
        <section className="ent-transcript-goal" aria-label="最初的用户任务"><strong>你</strong><p>{work.goal}</p></section>
        {error ? <div className="ent-transcript-notice" role="alert">{error}<button type="button" className="ent-btn sm" onClick={onReload}><RotateCcw size={13} aria-hidden />重新读取</button></div> : null}
        {loading ? <p className="ent-hint" role="status">正在读取执行过程…</p> : null}
        {nodes.map(node => <NodeSection key={node.step.id} node={node} employee={employees.find(employee => employee.id === node.step.employeeId)}
          files={work.deliverables.filter(file => file.nodeId === node.step.id)} onResults={onResults} />)}
        {!nodes.length && !loading ? <p className="ent-hint">尚未生成执行节点。</p> : null}
      </div>
    </div>
    {hasNewContent ? <button type="button" className="ent-btn sm ent-transcript-latest" onClick={() => {
      follow.current = true; setHasNewContent(false)
      if (body.current) body.current.scrollTop = body.current.scrollHeight
    }}><ArrowDown size={14} aria-hidden />回到最新</button> : null}
  </section>
}

function NodeSection({ node, employee, files, onResults }: {
  node: NodeTranscript; employee?: SiliconEmployee; files: WorkItem['deliverables']; onResults: () => void
}) {
  const { step, entries } = node
  const active = step.state === 'running' || step.state === 'waiting-user'
  const phase = active ? 'active' : step.state
  const [choice, setChoice] = useState<{ state: string; open: boolean } | null>(null)
  const body = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  // Completion resets the default; token updates and approval waits preserve manual choices.
  const open = choice?.state === phase ? choice.open : active
  useEffect(() => {
    if (open && active && follow.current && body.current) body.current.scrollTop = body.current.scrollHeight
  }, [entries, open, active])
  return <section className={`ent-transcript-node ${step.state}`} data-node-id={step.id} aria-label={`${step.employeeName} · ${step.title}`}>
    <button type="button" className="ent-transcript-node-heading" aria-expanded={open} aria-controls={`transcript-node-${step.id}`}
      onClick={() => setChoice({ state: phase, open: !open })}>
      {open ? <ChevronDown size={15} aria-hidden /> : <ChevronRight size={15} aria-hidden />}
      <EmployeeFace employee={employee} name={step.employeeName} size="sm" round />
      <span className="ent-transcript-node-name"><strong>{step.title}</strong><small>{step.employeeName}</small></span>
      <StepStateChip value={step.state} />
    </button>
    {!open && step.state === 'done' ? <p className="ent-transcript-collapsed">我已经完成工作。{files.length ? ` · ${files.length} 个产物` : ''}</p> : null}
    <div id={`transcript-node-${step.id}`} ref={body} className="ent-transcript-node-body" hidden={!open} tabIndex={open ? 0 : -1}
      role="region" aria-label={`${step.title}的消息`} onScroll={() => {
        const el = body.current
        if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
      }}>
      {entries.map(entry => <Entry key={entry.id} entry={entry} active={active} />)}
      {step.state === 'done' ? <p className="ent-transcript-completed"><CheckCircle2 size={15} aria-hidden />我已经完成工作。</p>
        : step.state === 'failed' ? <p className="ent-transcript-failed"><XCircle size={15} aria-hidden />当前节点执行失败，已产生的内容保留。</p>
          : active ? <p className="ent-transcript-waiting" role="status"><LoaderCircle size={13} className="ent-spin" aria-hidden />{step.state === 'waiting-user' ? '等待你的确认' : entries.length ? '正在继续处理任务…' : '正在准备执行…'}</p> : null}
      {files.length ? <button type="button" className="ent-btn sm ghost" onClick={onResults}><FileOutput size={14} aria-hidden />查看 {files.length} 个产物</button> : null}
    </div>
  </section>
}

function Entry({ entry, active }: { entry: TranscriptEntry; active: boolean }) {
  if (entry.kind === 'thinking') return entry.text.length > 160
    ? <details className="ent-transcript-thinking"><summary><Brain size={14} aria-hidden />思考过程<span>{entry.text.length} 字符</span></summary><p>{entry.text}</p></details>
    : <div className="ent-transcript-thinking short"><span><Brain size={14} aria-hidden />思考过程</span><p>{entry.text}</p></div>
  if (entry.kind === 'text') return <div className="ent-transcript-reply"><MessageContent content={entry.text} /></div>
  const state = entry.kind === 'tool' ? entry.state === 'running' && !active ? 'interrupted' : entry.state : undefined
  return <div className={`ent-transcript-operation ${state ?? ''}`}>
    {state === 'failed' ? <XCircle size={14} aria-hidden /> : state === 'completed' ? <CheckCircle2 size={14} aria-hidden /> : <Wrench size={14} aria-hidden />}
    <span>{entry.text}</span><small>{state === 'running' ? '进行中' : state === 'completed' ? '已完成' : state === 'failed' ? '失败' : state === 'interrupted' ? '已中断' : ''}</small>
  </div>
}
