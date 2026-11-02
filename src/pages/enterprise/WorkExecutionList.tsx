import { ChevronRight } from 'lucide-react'
import type { WorkExecutionGroup } from '../../features/enterprise/work-execution-groups'
import { dayTimeText } from '../../features/enterprise/vocabulary'
import { WorkStatusIcon, workStatusLabel } from '../../components/enterprise/WorkIndicators'

export function WorkExecutionList({ group, onSelect }: { group: WorkExecutionGroup; onSelect: (taskId: string) => void }) {
  return <section className="ent-work-executions" aria-label="运行记录">
    <header><h1>{group.work.title}</h1><p>共 {group.executions.length} 次运行</p></header>
    <ol>{group.executions.map(work => <li key={work.id}>
      <button type="button" onClick={() => onSelect(work.id)}>
        <WorkStatusIcon work={work} hint={false} />
        <span className="ent-work-execution-name"><strong>第{work.executionGroup?.number ?? 1}次运行</strong>
          <small>{work.startedAt === null ? '创建于' : '开始于'} {dayTimeText(work.startedAt ?? work.createdAt)}{work.completedAt !== null && work.completedAt !== undefined ? ` · 结束于 ${dayTimeText(work.completedAt)}` : ''}</small>
        </span>
        <span>{workStatusLabel(work)}</span><ChevronRight size={16} aria-hidden />
      </button>
    </li>)}</ol>
  </section>
}
