import { ArrowLeft, CalendarClock, Plus } from 'lucide-react'
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace'
import { useScheduledTasks } from '../../features/enterprise/use-scheduled-tasks'
import { ScheduledTaskEditor } from '../../components/enterprise/scheduled/ScheduledTaskEditor'
import { ScheduledTaskDetail } from '../../components/enterprise/scheduled/ScheduledTaskDetail'
import { ScheduledTaskHome } from '../../components/enterprise/scheduled/ScheduledTaskHome'
import { WorkScheduleDialog } from '../../components/enterprise/scheduled/WorkScheduleDialog'

export function ScheduledTasksPage({ workspace, scopeKey }: { workspace: EnterpriseWorkspace; scopeKey?: string }) {
  return <ScopedScheduledTasksPage key={scopeKey ?? 'local'} workspace={workspace} scopeKey={scopeKey} />
}

function ScopedScheduledTasksPage({ workspace, scopeKey }: { workspace: EnterpriseWorkspace; scopeKey?: string }) {
  const model = useScheduledTasks(undefined, scopeKey)
  const route = workspace.route.name === 'scheduled' ? workspace.route : { name: 'scheduled' as const }
  const definition = model.data?.definitions.find(item => item.id === route.taskId)
  const editor = route.view === 'new' || route.view === 'edit'
  const homepage = !route.taskId
  const back = () => workspace.replaceRoute({ name: 'scheduled' })
  const create = () => workspace.navigate({ name: 'scheduled', view: 'new' })

  return <div className={`ent-page ent-scheduled${homepage ? ' ent-sch-home-page' : ''}`} aria-busy={model.busy}>
    {route.taskId ? <button type="button" className="ent-btn ghost sm" onClick={back} disabled={model.busy}><ArrowLeft size={14} />返回首页</button> : null}
    {model.error ? <div className="ent-sch-notice error" role="alert"><span>{model.error}</span><button className="ent-btn sm" type="button" onClick={() => void model.refresh()} disabled={model.busy}>重新加载</button></div> : null}
    {model.data && model.data.schedulerState !== 'running' ? <div className="ent-sch-notice" role="status"><span>本地调度已停止。请检查登录、存储和已有执行记录后恢复。</span><button type="button" className="ent-btn sm" disabled={model.busy} onClick={() => void model.resume()}>恢复调度</button></div> : null}
    {model.loading ? <p role="status">正在读取定时任务…</p> : !model.data ? <div className="ent-sch-empty"><CalendarClock size={32} /><h2>暂时无法读取任务</h2><p>请重新加载。现有记录不会被覆盖或重新创建。</p></div> : route.taskId ? (
      definition ? <ScheduledTaskDetail definition={definition} workspace={workspace} model={model} /> : <p>未找到这项任务，请返回首页。</p>
    ) : <>
      <header className="ent-sch-toolbar ent-sch-home-toolbar"><button type="button" className="ent-btn primary" onClick={() => create()}><Plus size={16} />新建定时任务</button></header>
      <ScheduledTaskHome workspace={workspace} model={model} />
    </>}
    {editor && model.data && (route.view === 'new' || definition) ? definition?.plan?.kind === 'arrangement' && definition.plan.source
      ? <WorkScheduleDialog key={definition.id} definition={definition} scopeKey={scopeKey ?? 'local'} onClose={() => workspace.replaceRoute({ name: 'scheduled', taskId: definition.id, view: 'configuration' })} onCreated={saved => { void model.refresh(); workspace.replaceRoute({ name: 'scheduled', taskId: saved.id, view: 'configuration' }) }} />
      : <ScheduledTaskEditor key={route.taskId ?? 'new'} definition={route.view === 'edit' ? definition : undefined} workspace={workspace} model={model} /> : null}
  </div>
}
