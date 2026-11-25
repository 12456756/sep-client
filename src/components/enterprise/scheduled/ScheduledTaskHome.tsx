import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowLeft, ArrowUp, CalendarClock, ChevronDown, History, MoreHorizontal, Pause, Pencil, Play, Plus, Search, Trash2, X } from 'lucide-react'
import scheduledClock from '../../../assets/scheduled-clock.png'
import type { ScheduledDefinition, ScheduledOccurrence } from '../../../shared/scheduled-tasks'
import type { EnterpriseWorkspace } from '../../../features/enterprise/useEnterpriseWorkspace'
import type { ScheduledTasksModel } from '../../../features/enterprise/use-scheduled-tasks'
import { definitionLabel, recurrenceLabel, scheduledHomeGroups, scheduledTaskActions } from '../../../features/enterprise/scheduled-task-model'
import { authorizedScheduledModels, emptyScheduledTaskDraft, SCHEDULE_EXAMPLES } from '../../../features/enterprise/scheduled-task-home'
import type { ScheduledCreation, ScheduledCreationRequest } from '../../../shared/scheduled-creation'
import { creationAccepted } from '../../../features/enterprise/scheduled-task-client'
import { ScheduledExecutionFields } from './ScheduledExecutionFields'
import { ScheduledCreationList } from './ScheduledCreationList'
import { ScheduledTaskDetail } from './ScheduledTaskDetail'
import { ComposerResizeHandle } from '../ComposerResizeHandle'
import { useModelPreference } from '../../workspace/model-preference-scope'
import { resolveTaskModel } from '../../../shared/model-preferences'
import { FileMentionChips, FileMentionPicker } from '../attachments/FileMentionPicker'
import { FileMentionEditor } from '../attachments/FileMentionEditor'
import { useTextReferenceComposer } from '../attachments/use-text-reference-composer'
import { ContentActionMenu, type ContentMenuItem } from '../../ContentCopyMenu'
import { useFeedback } from '../../feedback/FeedbackProvider'
import { useOperationFeedback } from '../../feedback/use-operation-feedback'

interface Props { workspace: EnterpriseWorkspace; model: ScheduledTasksModel; selectedDefinition?: ScheduledDefinition; onCreate(): void }
type Example = typeof SCHEDULE_EXAMPLES[number]
const taskMenuItems = {
  edit: { label: '编辑任务', icon: Pencil },
  pause: { label: '暂停后续调度', icon: Pause },
  resume: { label: '恢复调度', icon: Play },
  history: { label: '查看执行记录', icon: History },
  reschedule: { label: '重新安排', icon: CalendarClock },
  archive: { label: '删除任务', icon: Trash2, separator: true, danger: true },
} satisfies Record<ReturnType<typeof scheduledTaskActions>[number]['id'], ContentMenuItem>

export function ScheduledTaskHome({ workspace, model, selectedDefinition, onCreate }: Props) {
  const feedback = useFeedback()
  const { capture } = useOperationFeedback(workspace.attachmentScopeKey)
  const [searching, setSearching] = useState(false)
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState(emptyScheduledTaskDraft)
  const [replacement, setReplacement] = useState<Example | null>(null)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const composer = useRef<HTMLFieldSetElement>(null)
  const mainPane = useRef<HTMLElement>(null)
  const resizeScrollFrame = useRef<number | null>(null)
  const lastExample = useRef('')
  const submitted = useRef<ScheduledCreationRequest | null>(null)
  const submittedText = useRef('')
  const [continuationId, setContinuationId] = useState<string | null>(null)
  const [container] = useState(() => typeof document === 'undefined' ? undefined : document.querySelector<HTMLElement>('.ent-shell') ?? undefined)
  const data = model.data
  const continuation = data?.creations?.find(item => item.id === continuationId && !item.deleted)
  const models = authorizedScheduledModels(workspace.myEmployees)
  const { defaultModelId } = useModelPreference()
  const settings = { ...draft.settings, modelId: continuation
    ? draft.settings.modelId || continuation.request.modelId
    : resolveTaskModel(models, defaultModelId, draft.settings.modelId) }
  const pending = model.pendingCreations ?? []
  const awaiting = pending.some(item => item.request.requestId === continuationId || item.request.requestId === submitted.current?.requestId) || (!continuationId && pending.length > 0)
  const sending = pending.some(item => item.sending && item.request.requestId === submitted.current?.requestId)
  const files = useTextReferenceComposer({ input, value: draft.goal, update: goal => setDraft(value => ({ ...value, goal })), bindingKey: `${workspace.attachmentScopeKey}:${continuationId ?? 'new-schedule'}`, disabled: awaiting })
  const { mention } = files
  useEffect(() => {
    const request = submitted.current
    if (!request || !data?.creations?.some(item => creationAccepted(item, request))) return
    setDraft(value => ({ ...value,
      goal: value.goal.trim() === submittedText.current ? '' : value.goal,
      settings: request.expectedRevision === undefined ? value.settings : { ...value.settings, modelId: '' },
    }))
    setContinuationId(null)
    submitted.current = null
  }, [data])
  const groups = useMemo(() => scheduledHomeGroups(data?.definitions ?? [], data?.occurrences ?? []), [data])
  const runsByDefinition = useMemo(() => {
    const grouped = new Map<string, ScheduledOccurrence[]>()
    for (const run of data?.occurrences ?? []) {
      const runs = grouped.get(run.definitionId)
      if (runs) runs.push(run)
      else grouped.set(run.definitionId, [run])
    }
    return grouped
  }, [data?.occurrences])
  const applyExample = (example: Example) => {
    setDraft(value => ({ ...value, goal: example.prompt }))
    lastExample.current = example.prompt
    setReplacement(null)
    input.current?.focus({ preventScroll: true })
  }
  const selectExample = (example: Example) => {
    if (draft.goal.trim() && draft.goal !== lastExample.current && draft.goal !== example.prompt) setReplacement(example)
    else applyExample(example)
  }
  const submit = () => {
    if (!draft.goal.trim() || awaiting || files.blocked || !settings.workDir.trim() || !models.includes(settings.modelId)) return
    if (settings.permissions.preset === 'read-only') return
    if (continuationId && (!continuation || !['needs_input', 'blocked'].includes(continuation.stage))) return
    const request: ScheduledCreationRequest = {
      requestId: continuation?.id ?? crypto.randomUUID(), ...(continuation ? { expectedRevision: continuation.revision } : {}),
      message: mention.submissionText.trim(), modelId: settings.modelId, workDir: settings.workDir.trim(), timezone: continuation?.request.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      permissions: { preset: settings.permissions.preset, approvalMode: settings.permissions.approvalMode ?? 'confirm-each' },
      ...(files.referenceFiles ? { referenceFiles: files.referenceFiles } : {}),
    }
    submitted.current = request
    submittedText.current = draft.goal.trim()
    void model.submitCreation(request)
  }
  const resume = (creation: ScheduledCreation) => {
    if (awaiting) return
    setContinuationId(creation.id)
    setDraft(value => ({ ...value, goal: '', settings: { ...value.settings, workDir: creation.request.workDir, modelId: '', permissions: { ...creation.request.permissions } } }))
    focusComposer()
  }
  const open = (id: string) => workspace.navigate({ name: 'scheduled', taskId: id, view: 'history' })
  const deleteTask = (item: ScheduledDefinition) => {
    const binding = capture()
    void feedback.confirm({
      key: `delete-scheduled-task:${item.id}`,
      title: '删除定时任务',
      message: `删除「${item.input.name}」？删除后不再调度，已有执行记录和产出文件会保留。`,
      actionLabel: '删除任务',
      busyLabel: '正在删除…',
      onConfirm: async () => {
        if (!binding.isCurrent()) return { success: false, message: '当前工作区已切换，请关闭弹窗后重试。' }
        const result = await model.archive(item)
        return result?.success ? { success: true } : { success: false, message: result?.error?.message || '删除结果未确认，请刷新后重试。' }
      },
    })
  }
  const focusComposer = () => {
    workspace.replaceRoute({ name: 'scheduled' })
    requestAnimationFrame(() => input.current?.focus({ preventScroll: true }))
  }
  const scrollWithComposer = useCallback(() => {
    if (resizeScrollFrame.current !== null) return
    resizeScrollFrame.current = requestAnimationFrame(() => {
      resizeScrollFrame.current = null
      const pane = mainPane.current
      const target = composer.current
      if (!pane || !target) return
      const overflow = target.getBoundingClientRect().bottom - pane.getBoundingClientRect().bottom + 12
      if (overflow > 0) pane.scrollBy({ top: overflow })
    })
  }, [])
  useEffect(() => () => { if (resizeScrollFrame.current !== null) cancelAnimationFrame(resizeScrollFrame.current) }, [])
  const creationDefinitions = new Set(data?.creations?.filter(item => !item.deleted && item.stage !== 'cancelled').map(item => item.definitionId))
  const pendingDefinitions = groups.pending.filter(item => !creationDefinitions.has(item.id))
  const matches = (item: ScheduledDefinition) => `${item.input.name} ${item.input.goal}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
  const list = (items: ScheduledDefinition[], label: string, inHistory = false) => items.length ? <section className="ent-sch-nav-group" aria-label={label}>
    {items.filter(matches).map(item => <ContentActionMenu key={item.id} className="ent-sch-nav-row"
        label="定时任务操作" triggerLabel={`更多操作：${item.input.name}`} triggerClassName="ent-sch-nav-menu"
        triggerIcon={<MoreHorizontal size={16} aria-hidden />}
        items={scheduledTaskActions(item, runsByDefinition.get(item.id) ?? [], { inHistory, busy: model.busy }).map(action => ({ ...taskMenuItems[action.id], ...action }))}
        onSelect={({ id }) => {
          switch (id) {
            case 'edit': case 'reschedule': workspace.navigate({ name: 'scheduled', taskId: item.id, view: 'edit' }); break
            case 'history': open(item.id); break
            case 'pause': void model.pause(item); break
            case 'resume': void model.confirm(item); break
            case 'archive': deleteTask(item); break
          }
        }}>
      <button type="button" className="ent-sch-nav-task" aria-current={selectedDefinition?.id === item.id ? 'page' : undefined} onClick={() => workspace.navigate({ name: 'scheduled', taskId: item.id, view: !inHistory && !item.plan && !item.enabled ? 'edit' : 'history' })}>
        <span className="ent-sch-nav-task-title"><strong title={item.input.name}>{item.input.name}</strong>{inHistory && <span className="ent-sch-state">{definitionLabel(item, inHistory)}</span>}</span>
        <span className="ent-sch-nav-task-recurrence">{recurrenceLabel(item)}</span>
      </button>
    </ContentActionMenu>)}
  </section> : null
  const hasCreations = Boolean(data?.creations?.some(item => !item.deleted) || pending.length)
  const creationsView = workspace.route.name === 'scheduled' && workspace.route.view === 'creations'
  const missingTask = workspace.route.name === 'scheduled' && workspace.route.taskId && !selectedDefinition
  const home = !creationsView && !selectedDefinition && !missingTask

  return <div className="ent-sch-workspace">
    <aside className="ent-sch-sidebar" aria-label="定时任务导航">
      <header><h2>定时任务</h2><button className="ent-sch-close" type="button" aria-label="搜索定时任务" title="搜索定时任务" aria-expanded={searching} onClick={() => { setSearching(value => !value); setSearch('') }}><Search size={17} /></button></header>
      {searching ? <label className="ent-sch-search"><Search size={14} aria-hidden /><input autoFocus type="search" aria-label="搜索任务名称或内容" value={search} onChange={event => setSearch(event.target.value)} /></label> : null}
      <button type="button" className="ent-sch-nav-new" onClick={focusComposer}><Plus size={18} />新建任务</button>
      <div className="ent-sch-nav-scroll" aria-label="定时任务概览" tabIndex={0}>
        {list(groups.active, '进行中的定时任务')}
        {pendingDefinitions.length ? <><h3>待完成</h3>{list(pendingDefinitions, '待完成的定时任务')}</> : null}
        <details className="ent-sch-nav-fold" open><summary>已暂停<ChevronDown size={14} /><small>{groups.paused.length || ''}</small></summary>{list(groups.paused, '已暂停的定时任务')}</details>
        {groups.history.length ? <details className="ent-sch-nav-fold"><summary>历史记录<ChevronDown size={14} /><small>{groups.history.length}</small></summary>{list(groups.history, '定时任务历史', true)}</details> : null}
        {search.trim() && ![...groups.active, ...groups.paused, ...pendingDefinitions, ...groups.history].some(matches) ? <p className="ent-sch-search-empty">没有匹配的任务</p> : null}
        {hasCreations || creationsView ? <button type="button" className="ent-sch-nav-new" aria-current={creationsView ? 'page' : undefined} onClick={() => workspace.replaceRoute({ name: 'scheduled', view: 'creations' })}>创建进度</button> : null}
      </div>
    </aside>
    <section ref={mainPane} className={`ent-sch-main-pane${home ? ' ent-sch-compose-pane' : ''}`} aria-label="定时任务内容">
      {!home ? <><button type="button" className="ent-btn ghost sm" onClick={() => workspace.replaceRoute({ name: 'scheduled' })}><ArrowLeft size={14} />返回首页</button>{creationsView ? hasCreations ? <ScheduledCreationList model={model} onResume={resume} onOpen={open} /> : <p role="status">暂无创建进度。</p> : selectedDefinition ? <ScheduledTaskDetail key={selectedDefinition.id} definition={selectedDefinition} workspace={workspace} model={model} inHistory={groups.history.some(item => item.id === selectedDefinition.id)} onDelete={deleteTask} /> : <p role="status">未找到这项任务，请返回首页。</p>}</> : <>
      <div className="ent-sch-home-content" tabIndex={0} aria-label="定时任务创建区">
        <div className="ent-sch-welcome"><img className="ent-sch-clock" src={scheduledClock} width={80} height={80} alt="" /><h2>安排任务</h2>
        <section className="ent-sch-examples" aria-label="定时任务示例"><h3>常用任务</h3>
        <div className="ent-sch-home-grid">{SCHEDULE_EXAMPLES.map(example => <button type="button" key={example.id} className="ent-sch-example" aria-label={`使用示例：${example.title}`} disabled={model.busy} onClick={() => selectExample(example)}><span><strong>{example.title}</strong><span>{example.description}</span></span><Plus size={19} aria-hidden /></button>)}</div>
        </section>
        </div>
      </div>
    <form className="ent-sch-home-compose" onSubmit={event => { event.preventDefault(); submit() }}>
      <div className="ent-sch-home-compose-actions"><button type="button" className="ent-btn ghost sm" title="设置任务时间和产出目录" onClick={onCreate}>手动设置</button></div>
      {continuation ? <div className="ent-sch-replying"><span>补充：{continuation.interpretation?.task.title ?? continuation.request.message}</span><button type="button" aria-label="退出补充" title="退出补充" disabled={awaiting} onClick={() => { setContinuationId(null); setDraft(value => ({ ...value, goal: '', settings: { ...value.settings, modelId: '' } })) }}><X size={14} /></button></div> : null}
      <fieldset ref={composer} disabled={sending} className="ent-sch-composer">
        <label className="sr-only" htmlFor="schedule-home-goal">定时任务工作内容</label><FileMentionEditor mention={mention} id="schedule-home-goal" ref={input} {...mention.editorAria} rows={2} value={draft.goal} maxLength={16000} placeholder={continuation ? '补充缺少的信息…' : '安排一项定期完成的工作…'} onChange={event => mention.change(event.currentTarget, (event.nativeEvent as InputEvent).inputType)} onCompositionStart={mention.compositionStart} onCompositionEnd={event => mention.compositionEnd(event.currentTarget)} onKeyDown={event => { mention.keyDown(event); if (!event.defaultPrevented && event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); submit() } }} />
        <FileMentionChips mention={mention} />
        {(files.referenceFiles || files.error) && <div className="ent-file-reference-tools ent-sch-reference-status">{files.referenceFiles && <small>仅用于创建与补充</small>}{files.error && <span role="alert" className="ent-file-mention-error">{files.error}</span>}</div>}
        <ScheduledExecutionFields naturalLanguage leadingAction={<FileMentionPicker mention={mention} />} value={{ ...draft, settings }} employees={workspace.myEmployees} onChange={patch => setDraft(value => ({ ...value, ...patch, settings: { ...value.settings, ...patch.settings } }))} action={<button type="submit" className="ent-sch-home-send" aria-label={continuation ? '发送补充信息' : '创建并启用定时任务'} title={continuation ? '发送补充信息' : '创建并启用'} disabled={awaiting || files.blocked || !draft.goal.trim() || !settings.workDir.trim() || !models.includes(settings.modelId)}><ArrowUp size={19} aria-hidden /></button>} onChooseFolder={async path => {
          try { const chosen = await workspace.chooseFolder(path); setError(null); return chosen }
          catch { setError('无法选择目录，请重试。'); return null }
        }} />
        <ComposerResizeHandle inputRef={input} resizeTargetRef={composer} onResize={scrollWithComposer} />
      </fieldset>
      {error ? <p role="alert" className="ent-sch-modal-error">{error}</p> : null}
    </form>
      </>}
    </section>
    <Dialog.Root open={replacement !== null} onOpenChange={open => { if (!open) setReplacement(null) }}><Dialog.Portal container={container}><Dialog.Overlay className="ent-sch-modal-overlay" /><Dialog.Content role="alertdialog" className="ent-sch-replace-dialog" onCloseAutoFocus={event => { event.preventDefault(); input.current?.focus({ preventScroll: true }) }}><Dialog.Title>替换当前内容？</Dialog.Title><Dialog.Description>当前内容已编辑，使用新示例会替换工作内容，其他设置保持不变。</Dialog.Description><footer><Dialog.Close asChild><button type="button" className="ent-btn">保留内容</button></Dialog.Close><button type="button" className="ent-btn primary" onClick={() => { if (replacement) applyExample(replacement) }}>替换内容</button></footer></Dialog.Content></Dialog.Portal></Dialog.Root>
  </div>
}
