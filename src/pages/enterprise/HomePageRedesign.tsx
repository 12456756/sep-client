import { ArrowRight, BadgeHelp, BookOpen, Bot, ChartPie, ChevronRight, Clock3, Flame, LayoutGrid, RefreshCw, Settings, ShieldPlus, Sun, TriangleAlert, Users, Workflow, Zap } from 'lucide-react'
import * as Dialog from '@radix-ui/react-dialog'
import { useMemo, useState, type ReactNode } from 'react'
import { EmployeeFace } from '../../components/enterprise/EmployeeFace'
import { HomeAssistantCard } from '../../components/enterprise/home/HomeAssistantCard'
import { workTypeLabel } from '../../components/enterprise/WorkIndicators'
import { createHomeDraft, type HomeDraft } from '../../features/enterprise/home-draft'
import { createHomeViewModel } from '../../features/enterprise/home-view-model'
import type { EnterpriseWorkspace, ConversationOptions } from '../../features/enterprise/useEnterpriseWorkspace'
import type { EmployeeLoadState } from '../../features/enterprise/use-workspace-employees'
import type { AppRoute, SiliconEmployee, WorkItem } from '../../features/enterprise/types'
import { relativeTime } from '../../features/enterprise/vocabulary'
import '../../styles/home-v2.css'

export interface HomeDashboardProps {
  userName: string
  employees: SiliconEmployee[]
  works: WorkItem[]
  draft: HomeDraft
  onNavigate: (route: AppRoute) => void
  onSubmit: (employeeId: string, text: string, options?: ConversationOptions) => Promise<boolean>
  demo?: boolean
  now?: number
  visualStats?: { total: number; working: number; idle: number }
  employeeLoad?: EmployeeLoadState
  employeeStatusLoad?: EmployeeLoadState
  workListLoad?: EmployeeLoadState
  busy?: boolean
}

interface Props {
  workspace: EnterpriseWorkspace
  userName?: string
  employeeLoad?: EmployeeLoadState
  employeeStatusLoad?: EmployeeLoadState
  draft?: HomeDraft
}

export function HomePageRedesign({ workspace, userName, employeeLoad, employeeStatusLoad, draft }: Props) {
  const [fallbackDraft] = useState(createHomeDraft)
  return <HomeDashboard userName={userName ?? workspace.userName} employees={workspace.employees} works={workspace.works}
    draft={draft ?? fallbackDraft} onNavigate={workspace.navigate} onSubmit={workspace.startConversation} busy={workspace.busy}
    employeeLoad={employeeLoad} employeeStatusLoad={employeeStatusLoad} workListLoad={workspace.workListLoad} />
}

export function HomeDashboard({ userName, employees, works, draft, onNavigate, onSubmit, demo = false, now = Date.now(), visualStats, employeeLoad, employeeStatusLoad, workListLoad, busy = false }: HomeDashboardProps) {
  const model = useMemo(() => createHomeViewModel(employees, works), [employees, works])
  const [tab, setTab] = useState<'recommended' | 'recent'>('recommended')
  const [batch, setBatch] = useState(0)
  const [toolNotice, setToolNotice] = useState(false)
  const stats = demo && visualStats ? visualStats : model.stats
  const visibleEmployees = tab === 'recent' ? model.recentEmployees : model.recommendedEmployees
  const popularPool = demo && model.roster.length > 5 ? model.roster.slice(5) : model.allRecommendedEmployees
  const popular = Array.from({ length: Math.min(6, popularPool.length) }, (_, i) => popularPool[(batch * 6 + i) % popularPool.length])
  const hour = new Date(now).getHours()
  const greeting = hour < 6 ? '夜深了' : hour < 12 ? '上午好' : hour < 18 ? '下午好' : '晚上好'
  const loading = employeeLoad?.loading
  const statsUnknown = loading || employeeLoad?.error
  const activityUnknown = statsUnknown || employeeStatusLoad?.loading || employeeStatusLoad?.error || workListLoad?.loading || workListLoad?.error
  const activeIds = useMemo(() => new Set(works.filter(work => work.isActive === true).flatMap(work => [work.currentEmployeeId, ...work.participants])), [works])

  return <div className="sep-home">
    <div className="sep-home-main">
      <header className="sep-home-greeting">
        <div className="sep-home-welcome"><Sun size={29} strokeWidth={1.6} aria-hidden /><div><h1>{userName}，{greeting}</h1><p>AI 让工作更简单，让团队更强大！</p></div></div>
        <div className="sep-home-stats" aria-label="智能体概览">
          <Stat icon={<Users />} label="总数" value={statsUnknown ? null : stats.total} tone="total" />
          <Stat icon={<Zap fill="currentColor" />} label="工作中" value={activityUnknown ? null : stats.working} tone="working" />
          <Stat icon={<ChartPie />} label="空闲" value={activityUnknown ? null : stats.idle} tone="idle" />
        </div>
      </header>
      <HomeAssistantCard employees={model.roster} works={model.recentWorks} draft={draft} onSubmit={onSubmit}
        onCreate={() => onNavigate({ name: 'arrange', mode: 'pick' })} demo={demo} busy={busy || Boolean(employeeLoad?.loading)} />
      <section className="sep-home-employees" aria-label="我的智能体">
        <div className="sep-home-section-heading">
          <h2><Settings size={20} aria-hidden />我的智能体</h2>
          <div className="sep-home-tabs" role="tablist" aria-label="智能体列表范围" onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const next = event.key === 'Home' ? 'recommended' : event.key === 'End' ? 'recent' : tab === 'recommended' ? 'recent' : 'recommended'
            setTab(next)
            document.getElementById(`home-${next}-tab`)?.focus()
          }}>
            <button id="home-recommended-tab" type="button" role="tab" tabIndex={tab === 'recommended' ? 0 : -1} aria-selected={tab === 'recommended'} aria-controls="home-employee-list" onClick={() => setTab('recommended')}>推荐</button>
            <button id="home-recent-tab" type="button" role="tab" tabIndex={tab === 'recent' ? 0 : -1} aria-selected={tab === 'recent'} aria-controls="home-employee-list" onClick={() => setTab('recent')}>最近使用</button>
          </div>
          <More label="查看全部" onClick={() => onNavigate({ name: 'employees', scope: 'mine' })} />
        </div>
        <div id="home-employee-list" role="tabpanel" aria-labelledby={tab === 'recommended' ? 'home-recommended-tab' : 'home-recent-tab'} className="sep-home-employee-grid">
          {loading ? <SkeletonCards count={5} /> : employeeLoad?.error ? <InlineState message={employeeLoad.error} onRetry={employeeLoad.retry} />
            : visibleEmployees.length ? visibleEmployees.map(employee => <button type="button" className="sep-home-employee" key={employee.id} onClick={() => onNavigate({ name: 'employee', employeeId: employee.id })}>
              <span className="sep-home-employee-identity"><EmployeeFace employee={employee} size="sm" round /><span><strong title={employee.name}>{employee.name}</strong><small title={employee.roleName}>{employee.roleName}</small></span></span>
              <EmployeeStatus employee={employee} working={activeIds.has(employee.id)} unknown={Boolean(employeeStatusLoad?.loading || employeeStatusLoad?.error || workListLoad?.loading || workListLoad?.error)} />
            </button>) : <InlineState message={tab === 'recent' ? '还没有使用记录，选择一位智能体开始工作吧' : '暂时没有分配给你的智能体'} />}
        </div>
      </section>
      <section className="sep-home-popular" aria-label="热门推荐">
        <div className="sep-home-section-heading"><h2><Flame size={21} fill="currentColor" aria-hidden />热门推荐</h2><button type="button" className="sep-home-more" disabled={popularPool.length <= 6} onClick={() => setBatch(value => value + 1)}><RefreshCw size={14} aria-hidden />换一批</button></div>
        <div className="sep-home-popular-grid">{loading ? <SkeletonCards count={6} /> : popular.length ? popular.map(employee => <button type="button" className="sep-home-popular-card" key={employee.id} onClick={() => onNavigate({ name: 'employee', employeeId: employee.id })}><EmployeeFace employee={employee} size="sm" round /><strong title={employee.name}>{employee.name}</strong><small title={employee.roleName}>{employee.roleName}</small></button>) : <InlineState message="暂无可推荐的智能体" />}</div>
        {!demo && popular.length ? <span className="sep-home-recommendation-source">根据你可用的智能体推荐</span> : null}
      </section>
    </div>
    <aside className="sep-home-side" aria-label="首页摘要">
      <section className="sep-home-recent sep-home-panel" aria-label="最近任务">
        <div className="sep-home-section-heading"><h2><Clock3 size={18} aria-hidden />最近任务</h2><More label="查看全部" onClick={() => onNavigate({ name: 'records', bucket: 'all' })} /></div>
        <div className="sep-home-recent-list">{workListLoad?.loading ? <SkeletonCards count={5} /> : workListLoad?.error ? <InlineState message={workListLoad.error} onRetry={workListLoad.retry} /> : model.recentWorks.length ? model.recentWorks.map((work, i) => {
          const Icon = work.workType.state === 'resolved' && work.workType.kind === 'arrangement' ? Workflow : Bot
          return <button type="button" key={work.id} className={`sep-home-recent-row tone-${i}`} onClick={() => onNavigate({ name: 'work', workId: work.id })}><span className="sep-home-recent-icon"><Icon size={18} aria-hidden /></span><span className="sep-home-recent-copy"><strong title={work.title}>{work.title || '未命名工作'}</strong><small>{demo ? ['数据分析', '文案创作', '流程设计', '图像生成', '视频生成'][i] : workTypeLabel(work.workType)}</small></span><time dateTime={new Date(work.updatedAt).toISOString()}>{relativeTime(work.updatedAt, now)}</time></button>
        }) : <InlineState message="还没有任务，从第一项工作开始吧" />}</div>
      </section>
      <section className="sep-home-shortcuts sep-home-panel" aria-label="快捷入口">
        <div className="sep-home-section-heading"><h2><Zap size={20} fill="currentColor" aria-hidden />快捷入口</h2></div>
        <div className="sep-home-shortcut-grid">
          <Shortcut icon={<ShieldPlus />} title="创建任务" description="快速创建 AI 任务" tone="red" onClick={() => onNavigate({ name: 'arrange', mode: 'pick' })} />
          <Shortcut icon={<Users />} title="我的工作台" description="查看任务进度" tone="blue" onClick={() => onNavigate({ name: 'records', bucket: 'all' })} />
          <Shortcut icon={<BookOpen />} title="知识库" description="企业知识沉淀" tone="purple" onClick={() => onNavigate({ name: 'knowledge' })} />
          <Shortcut icon={<LayoutGrid />} title="工具中心" description="更多 AI 工具" tone="orange" onClick={() => setToolNotice(true)} />
        </div>
      </section>
      <section className="sep-home-brand" aria-label="品牌寄语"><blockquote>“用 AI 赋能业务<br /><span>让每个员工都成为数字员工”</span></blockquote></section>
    </aside>
    <HomeDialog open={toolNotice} onClose={() => setToolNotice(false)} title="工具中心"><p>工具中心暂未开放</p></HomeDialog>
  </div>
}

function Stat({ icon, label, value, tone }: { icon: ReactNode; label: string; value: number | null; tone: string }) {
  return <div className={`sep-home-stat ${tone}`}><span className="sep-home-stat-icon">{icon}</span><span><strong>{value ?? '—'}</strong><small>{label}</small></span></div>
}
function More({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" className="sep-home-more" onClick={onClick}>{label}<ChevronRight size={14} aria-hidden /></button>
}
function EmployeeStatus({ employee, working, unknown }: { employee: SiliconEmployee; working: boolean; unknown: boolean }) {
  const status = employee.availability
  const busy = working || status === 'working'
  const label = unknown ? '状态待更新' : status === 'needs-auth' ? '需授权' : status === 'unavailable' ? '不可用' : busy ? '工作中' : '空闲'
  return <span className={`sep-home-availability ${unknown ? 'unknown' : busy ? 'working' : status}`}><TriangleAlert size={11} aria-hidden />{label}</span>
}
function Shortcut({ icon, title, description, tone, onClick }: { icon: ReactNode; title: string; description: string; tone: string; onClick: () => void }) {
  return <button className={`sep-home-shortcut ${tone}`} type="button" onClick={onClick}><span>{icon}</span><strong>{title}</strong><small>{description}</small></button>
}
function InlineState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="sep-home-inline-state" role="status"><BadgeHelp size={20} aria-hidden /><p>{message}</p>{onRetry ? <button type="button" onClick={onRetry}>重试<ArrowRight size={13} aria-hidden /></button> : null}</div>
}
function SkeletonCards({ count }: { count: number }) {
  return <>{Array.from({ length: count }, (_, index) => <div key={index} className="sep-home-skeleton" aria-label="正在加载" />)}</>
}
export function HomeDialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  return <Dialog.Root open={open} onOpenChange={value => { if (!value) onClose() }}><Dialog.Portal><Dialog.Overlay className="sep-home-dialog-overlay" /><Dialog.Content className="sep-home-dialog" aria-describedby={undefined}><Dialog.Title>{title}</Dialog.Title>{children}<Dialog.Close className="sep-home-dialog-done">知道了</Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root>
}
