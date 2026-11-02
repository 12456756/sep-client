import { CircleAlert, CircleCheck, CircleDashed, CircleHelp, CircleX, Clock3, LoaderCircle, MessageSquare, Square, Workflow } from 'lucide-react'
import type { WorkItem } from '../../features/enterprise/types'
import { workStatusIndicator } from '../../features/enterprise/work-hub-state'
import { IconHint } from './IconHint'

const STATUS = {
  running: { icon: LoaderCircle, label: '工作中' },
  attention: { icon: CircleAlert, label: '待处理' },
  completed: { icon: CircleCheck, label: '已完成' },
  failed: { icon: CircleX, label: '执行失败' },
  paused: { icon: Square, label: '已终止' },
  unstarted: { icon: CircleDashed, label: '尚未开始' },
  queued: { icon: Clock3, label: '排队中' },
}

export function workStatusLabel(work: WorkItem): string {
  if (work.planningDraft) return work.planningDraft.status === 'planning' ? '正在规划'
    : work.status === 'failed' ? '规划失败' : work.status === 'paused' ? '已取消规划' : work.nextUserAction ?? '正在准备规划';
  return STATUS[workStatusIndicator(work)].label
}

export function workTypeLabel(workType: WorkItem['workType']): string {
  return workType.state === 'resolved' ? workType.kind === 'conversation' ? '会话' : '编排'
    : workType.state === 'loading' ? '类型加载中' : '类型暂不可用'
}

export function WorkStatusIcon({ work, hint = true, focusable = true }: { work: WorkItem; hint?: boolean; focusable?: boolean }) {
  const state = work.planningDraft?.status === 'planning' ? 'running' : workStatusIndicator(work)
  const { icon: Icon } = STATUS[state]
  const label = workStatusLabel(work)
  const glyph = <span className={`ent-work-status is-${state}`} role="img" aria-label={label} tabIndex={hint && focusable ? 0 : undefined}><Icon size={18} className={state === 'running' ? 'ent-spin' : undefined} aria-hidden /></span>
  return hint ? <IconHint label={label}>{glyph}</IconHint> : glyph
}

export function WorkTypeTag({ workType, hint = true, focusable = true }: { workType: WorkItem['workType']; hint?: boolean; focusable?: boolean }) {
  const Icon = workType.state === 'resolved' ? workType.kind === 'conversation' ? MessageSquare : Workflow
    : workType.state === 'loading' ? LoaderCircle : CircleHelp
  const label = workTypeLabel(workType)
  const tag = <span className="ent-work-type-tag" role="img" aria-label={label} tabIndex={hint && focusable ? 0 : undefined}><Icon size={13} className={workType.state === 'loading' ? 'ent-spin' : undefined} aria-hidden /></span>
  return hint ? <IconHint label={label}>{tag}</IconHint> : tag
}
