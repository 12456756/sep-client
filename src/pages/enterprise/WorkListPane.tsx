import { CircleAlert, CircleCheck, CircleHelp, Layers, ListFilter, LoaderCircle, MessageSquare, MoreHorizontal, Pin, Plus, RotateCcw, Search, Square, Workflow, X } from 'lucide-react'
import { IconHint } from '../../components/enterprise/IconHint'
import { WorkStatusIcon, WorkTypeTag, workStatusLabel, workTypeLabel } from '../../components/enterprise/WorkIndicators'
import type { WorkItem } from '../../features/enterprise/types'
import { countWorkRecordStatuses, countWorkRecordTypes, countUnresolvedWorkRecordTypes, type WorkRecordBucket, type WorkRecordFilterState, type WorkRecordTypeFilter } from '../../features/enterprise/work-record-filters'
import { relativeTime } from '../../features/enterprise/vocabulary'

const BUCKETS: { id: WorkRecordBucket; label: string; icon: typeof Layers }[] = [
  { id: 'all', label: '全部工作', icon: Layers },
  { id: 'active', label: '工作中', icon: LoaderCircle },
  { id: 'mine', label: '待处理', icon: CircleAlert },
  { id: 'done', label: '已完成', icon: CircleCheck },
  { id: 'stopped', label: '未完成（失败或终止）', icon: Square },
]
const TYPES: { id: WorkRecordTypeFilter; label: string; icon: typeof Layers }[] = [
  { id: 'all', label: '全部类型', icon: ListFilter },
  { id: 'conversation', label: '会话', icon: MessageSquare },
  { id: 'arrangement', label: '编排', icon: Workflow },
]

interface Props {
  works: WorkItem[]
  records: WorkItem[]
  selectedWorkId: string | null
  filters: WorkRecordFilterState
  onFilters: (filters: WorkRecordFilterState) => void
  onSelect: (id: string) => void
  onCreate: () => void
  onClose: () => void
  onRetryTypes: () => void
  menuWorkId: string | null
  onWorkMenu: (workId: string, trigger: HTMLElement, point?: { x: number; y: number }) => void
}

export function WorkListPane({ works, records, selectedWorkId, filters, onFilters, onSelect, onCreate, onClose, onRetryTypes, menuWorkId, onWorkMenu }: Props) {
  const statuses = countWorkRecordStatuses(works, filters)
  const types = countWorkRecordTypes(works, filters)
  const unresolved = countUnresolvedWorkRecordTypes(works, filters)
  return <aside className="ent-work-list" aria-label="工作列表" tabIndex={-1}>
    <header className="ent-work-list-heading">
      <IconHint label="新建工作"><button type="button" aria-label="新建工作" className="ent-work-icon create" onClick={onCreate}><Plus size={18} aria-hidden /></button></IconHint>
      <IconHint label="收起工作列表"><button type="button" aria-label="收起工作列表" className="ent-work-icon" onClick={onClose}><X size={16} aria-hidden /></button></IconHint>
    </header>
    <label className="ent-work-search"><Search size={15} aria-hidden /><input type="search" placeholder="搜索工作或员工" aria-label="搜索工作或员工" value={filters.search} onChange={event => onFilters({ ...filters, search: event.target.value })} /></label>
    <div className="ent-work-filters status-filters" role="group" aria-label="按状态筛选工作">
      {BUCKETS.map(({ id, label, icon: Icon }) => <IconHint key={id} label={`${label} · ${statuses[id]} 项`} side="bottom"><button type="button" className={`bucket-${id}`} aria-label={`${label}，${statuses[id]} 项`} aria-pressed={filters.bucket === id} onClick={() => onFilters({ ...filters, bucket: id })}><Icon size={16} aria-hidden /><span>{statuses[id]}</span></button></IconHint>)}
    </div>
    <div className="ent-work-filters type-filters" role="group" aria-label="按类型筛选工作">
      {TYPES.map(({ id, label, icon: Icon }) => <IconHint key={id} label={`${label} · ${types[id]} 项`} side="bottom"><button type="button" aria-label={`${label}，${types[id]} 项`} aria-pressed={filters.workType === id} onClick={() => onFilters({ ...filters, workType: id })}><Icon size={14} aria-hidden /><span>{types[id]}</span></button></IconHint>)}
      {unresolved.loading > 0 && <IconHint label={`${unresolved.loading} 项工作类型加载中，仅显示在全部类型中`}><span role="status" tabIndex={0} aria-label={`${unresolved.loading} 项工作类型加载中`}><LoaderCircle size={14} aria-hidden /></span></IconHint>}
      {unresolved.unavailable > 0 && <IconHint label={`${unresolved.unavailable} 项工作类型暂不可用，点击重试`}><button type="button" onClick={onRetryTypes} aria-label="重新读取工作类型"><CircleHelp size={14} aria-hidden /></button></IconHint>}
    </div>
    <div className="ent-work-list-scroll">
      {!records.length && <div className="ent-work-list-empty"><p>{works.length ? '没有符合筛选条件的工作' : '还没有工作'}</p>{works.length ? <button type="button" className="ent-btn sm ghost" onClick={() => onFilters({ bucket: 'all', workType: 'all', search: '' })}><RotateCcw size={14} aria-hidden />清除筛选</button> : <button type="button" className="ent-btn sm ghost" onClick={onCreate}><Plus size={14} aria-hidden />开始第一项工作</button>}</div>}
      {records.map(work => <div key={work.recordKey ?? work.id} className="ent-work-row-wrap">
        <button type="button" className={`ent-work-row${work.id === selectedWorkId ? ' selected' : ''}`} aria-current={work.id === selectedWorkId ? 'true' : undefined} aria-label={`${work.title}，${workStatusLabel(work)}，${workTypeLabel(work.workType)}`} aria-keyshortcuts="Shift+F10" onClick={() => onSelect(work.id)}
          onContextMenu={event => { event.preventDefault(); onWorkMenu(work.id, event.currentTarget, { x: event.clientX, y: event.clientY }) }}
          onKeyDown={event => { if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') { event.preventDefault(); onWorkMenu(work.id, event.currentTarget) } }}>
        <WorkStatusIcon work={work} focusable={false} />
        <span className="ent-work-row-body"><span className="ent-work-row-title"><strong>{work.title || '未命名工作'}</strong>{work.pinnedAt ? <span className="ent-work-pinned" role="img" aria-label="已置顶"><Pin size={12} aria-hidden /></span> : null}<WorkTypeTag workType={work.workType} focusable={false} /></span><span className="ent-work-row-summary">{work.nextUserAction || work.messages.at(-1)?.content || work.goal || '尚无消息'}</span><span className="ent-work-row-meta"><span>{work.currentEmployeeName || '待分配员工'}</span><time>{relativeTime(work.updatedAt)}</time></span></span>
        </button>
        <IconHint label="更多操作"><button type="button" className="ent-work-row-menu" aria-label={`更多操作：${work.title || '未命名工作'}`} aria-haspopup="menu" aria-expanded={menuWorkId === work.id} aria-controls={menuWorkId === work.id ? 'ent-work-context-menu' : undefined} onClick={event => onWorkMenu(work.id, event.currentTarget)}><MoreHorizontal size={16} aria-hidden /></button></IconHint>
      </div>)}
    </div>
  </aside>
}
