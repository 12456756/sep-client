import { useCallback, useLayoutEffect, useMemo, useState } from 'react'
import { ArrowLeft, PanelLeftOpen } from 'lucide-react'
import type { AppRoute } from '../../features/enterprise/types'
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace'
import { applyWorkOrder, enterWorkHubRoute, refreshWorkOrder, type WorkHubState } from '../../features/enterprise/work-hub-state'
import { filterWorkRecords, readWorkRecordFilters, resetWorkRecordFilters, type WorkRecordFilterState } from '../../features/enterprise/work-record-filters'
import { IconHint } from '../../components/enterprise/IconHint'
import { ArrangeWorkPage } from './ArrangeWorkPage'
import { WorkDetailPage } from './WorkDetailPage'
import { WorkListPane } from './WorkListPane'
import { WorkListActions, type WorkMenuRequest } from './WorkListActions'
import '../../styles/work-hub.css'
import { PlanningScope } from '../../features/enterprise/auto-planning-scope'
import { groupWorkExecutions, resolveExecutionSelection } from '../../features/enterprise/work-execution-groups'
import { WorkExecutionList } from './WorkExecutionList'
import { WorkScheduleDialog } from '../../components/enterprise/scheduled/WorkScheduleDialog'

type CreationRoute = Extract<AppRoute, { name: 'arrange' }>

export function WorkHubPage({ workspace }: { workspace: EnterpriseWorkspace }) {
  const { route } = workspace
  const groups = useMemo(() => groupWorkExecutions(workspace.works), [workspace.works])
  const groupedWorks = useMemo(() => groups.map(group => group.work), [groups])
  const resolveWorkId = (id: string | null) => {
    if (!id) return id
    return groups.find(group => group.work.id === id || group.work.recordKey === id || group.executions.some(work => work.id === id))?.work.id ?? id
  }
  const [state, setState] = useState<WorkHubState>(() => enterWorkHubRoute({ filters: readWorkRecordFilters(route), selectedWorkId: null }, route))
  const [creation, setCreation] = useState<CreationRoute>(() => route.name === 'arrange' ? route : { name: 'arrange' })
  const [creationVersion, setCreationVersion] = useState(0)
  const [listOpen, setListOpen] = useState(() => typeof window === 'undefined' || window.innerWidth >= 1180)
  const [order, setOrder] = useState(() => refreshWorkOrder(groupedWorks))
  const [workMenu, setWorkMenu] = useState<WorkMenuRequest | null>(null)
  const [scheduleSource, setScheduleSource] = useState<{ id: string; title: string } | null>(null)
  const dismissWorkMenu = useCallback(() => setWorkMenu(null), [])
  const openWorkMenu = (workId: string, trigger: HTMLElement, point?: { x: number; y: number }) => {
    const rect = trigger.getBoundingClientRect()
    setWorkMenu({ workId, trigger, x: point?.x ?? rect.right, y: point?.y ?? rect.bottom })
  }
  useLayoutEffect(() => {
    setState(current => enterWorkHubRoute(current, route))
    if (route.name === 'arrange') setCreation(route)
    setWorkMenu(null)
    setScheduleSource(null)
  }, [route])
  useLayoutEffect(() => { setWorkMenu(null); setScheduleSource(null) }, [workspace.attachmentScopeKey])
  const nextOrder = refreshWorkOrder(groupedWorks, order)
  useLayoutEffect(() => { setOrder(current => refreshWorkOrder(groupedWorks, current)) }, [groupedWorks])
  const creationRoute = route.name === 'arrange' ? route : creation
  const selectedWorkId = route.name === 'arrange' ? null : route.name === 'work' ? resolveWorkId(route.workId)
    : groupedWorks.some(work => work.id === resolveWorkId(state.selectedWorkId)) ? resolveWorkId(state.selectedWorkId) : null
  const selectedGroup = groups.find(group => group.work.id === selectedWorkId)
  const selectedWork = selectedGroup?.work
  const requestedExecution = route.name === 'work' ? route.executionTaskId
    ?? (route.workId !== selectedWorkId && selectedGroup?.executions.some(work => work.id === route.workId) ? route.workId : undefined) : undefined
  const selectedExecution = selectedGroup ? resolveExecutionSelection(selectedGroup, requestedExecution).detail : null
  const records = applyWorkOrder(filterWorkRecords(groupedWorks, state.filters), nextOrder)
  const excluded = Boolean(selectedWork && !records.some(work => work.id === selectedWork.id))
  const updateFilters = (filters: WorkRecordFilterState) => {
    setState(current => ({ ...current, filters }))
    setOrder(refreshWorkOrder(groupedWorks))
    if (route.name === 'records') workspace.replaceRoute({ name: 'records', ...filters })
  }
  return <PlanningScope controller={workspace.planningController}><div className={`ent-work-hub${listOpen ? ' list-open' : ''}`}>
    {listOpen && <WorkListPane works={groupedWorks} records={records} selectedWorkId={selectedWorkId} filters={state.filters} onFilters={updateFilters} onSelect={workId => workspace.navigate({ name: 'work', workId })} onCreate={() => workspace.navigate(creation)} onClose={() => { setListOpen(false); dismissWorkMenu() }} onRetryTypes={() => workspace.retryWorkTypes()} menuWorkId={workMenu?.workId ?? null} onWorkMenu={openWorkMenu} />}
    <WorkListActions key={workspace.attachmentScopeKey} works={groupedWorks} request={workMenu} busy={workspace.busy} onDismiss={dismissWorkMenu} onRename={workspace.renameWork} onPin={workspace.setWorkPinned} onRetry={workspace.rerunWork} onDelete={workspace.deleteWork} onSchedule={work => setScheduleSource({ id: work.id, title: work.title })} />
    {scheduleSource ? <WorkScheduleDialog key={`${workspace.attachmentScopeKey}:${scheduleSource.id}`} source={scheduleSource} scopeKey={workspace.attachmentScopeKey} onClose={() => setScheduleSource(null)} onCreated={definition => { setScheduleSource(null); workspace.navigate({ name: 'scheduled', taskId: definition.id, view: 'configuration' }) }} /> : null}
    <main className="ent-work-main" aria-label={selectedWork ? `工作：${selectedWork.title}` : '新建工作'}>
      {!listOpen && <div className="ent-work-reopen"><IconHint label="展开工作列表"><button type="button" className="ent-work-icon" aria-label="展开工作列表" onClick={() => setListOpen(true)}><PanelLeftOpen size={18} aria-hidden /></button></IconHint><span>工作</span></div>}
      {excluded && <div className="ent-work-excluded" role="status"><span>当前工作不符合列表筛选，仍保留此对话。</span><button type="button" onClick={() => updateFilters(resetWorkRecordFilters())}>清除筛选</button></div>}
      {/* Keep the creation composer mounted while reading work so unsent input survives. */}
      <section className="ent-work-create" hidden={Boolean(selectedWorkId)} aria-label="新建工作">
        <ArrangeWorkPage key={creationVersion} workspace={workspace} templateId={creationRoute.templateId} employeeId={creationRoute.employeeId} mode={creationRoute.mode ?? 'pick'} onWorkCreated={() => setCreationVersion(version => version + 1)} />
      </section>
      {selectedWork?.planningDraft ? <ArrangeWorkPage key={selectedWork.planningDraft.id} workspace={workspace} mode="auto" planningDraftId={selectedWork.planningDraft.id} />
        : selectedGroup && !selectedExecution ? <WorkExecutionList group={selectedGroup} onSelect={executionTaskId => workspace.navigate({ name: 'work', workId: selectedGroup.work.id, executionTaskId })} />
        : selectedExecution ? <>
          {selectedGroup && selectedGroup.executions.length > 1 && <div className="ent-work-execution-back"><button type="button" onClick={() => workspace.navigate({ name: 'work', workId: selectedGroup.work.id })}><ArrowLeft size={16} aria-hidden />返回运行记录</button><span>第{selectedExecution.executionGroup?.number ?? 1}次运行</span></div>}
          <WorkDetailPage key={selectedExecution.id} workspace={workspace} workId={selectedExecution.id} />
        </>
        : selectedWorkId && <WorkDetailPage workspace={workspace} workId={selectedWorkId} />}
    </main>
  </div></PlanningScope>
}
