import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowLeft, ArrowUp, ChevronDown, Plus, Search, X } from 'lucide-react'
import scheduledClock from '../../../assets/scheduled-clock.png'
import type { ScheduledDefinition } from '../../../shared/scheduled-tasks'
import type { EnterpriseWorkspace } from '../../../features/enterprise/useEnterpriseWorkspace'
import type { ScheduledTasksModel } from '../../../features/enterprise/use-scheduled-tasks'
import { recurrenceLabel, scheduledHomeGroups } from '../../../features/enterprise/scheduled-task-model'
import { authorizedScheduledModels, emptyScheduledTaskDraft, SCHEDULE_EXAMPLES } from '../../../features/enterprise/scheduled-task-home'
import type { ScheduledCreation, ScheduledCreationRequest } from '../../../shared/scheduled-creation'
import { creationAccepted } from '../../../features/enterprise/scheduled-task-client'
import { ScheduledExecutionFields } from './ScheduledExecutionFields'
import { ScheduledCreationList } from './ScheduledCreationList'
import { ScheduledTaskDetail } from './ScheduledTaskDetail'
import { ComposerResizeHandle } from '../ComposerResizeHandle'

interface Props { workspace: EnterpriseWorkspace; model: ScheduledTasksModel; selectedDefinition?: ScheduledDefinition; onCreate(): void }
type Example = typeof SCHEDULE_EXAMPLES[number]

export function ScheduledTaskHome({ workspace, model, selectedDefinition, onCreate }: Props) {
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
  const [continuationId, setContinuationId] = useState<string | null>(null)
  const [container] = useState(() => typeof document === 'undefined' ? undefined : document.querySelector<HTMLElement>('.ent-shell') ?? undefined)
  const data = model.data
  const continuation = data?.creations?.find(item => item.id === continuationId)
  const models = authorizedScheduledModels(workspace.myEmployees)
  const settings = { ...draft.settings, modelId: draft.settings.modelId || models[0] || '' }
  const pending = model.pendingCreations ?? []
  const awaiting = pending.some(item => item.request.requestId === continuationId || item.request.requestId === submitted.current?.requestId) || (!continuationId && pending.length > 0)
  const sending = pending.some(item => item.sending && item.request.requestId === submitted.current?.requestId)
  useEffect(() => {
    const request = submitted.current
    if (!request || !data?.creations?.some(item => creationAccepted(item, request))) return
    setDraft(value => value.goal.trim() === request.message ? { ...value, goal: '' } : value)
    setContinuationId(null)
    submitted.current = null
  }, [data])
  const groups = useMemo(() => scheduledHomeGroups(data?.definitions ?? [], data?.occurrences ?? []), [data])
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
    if (!draft.goal.trim() || awaiting || !settings.workDir.trim() || !models.includes(settings.modelId)) return
    if (settings.permissions.preset === 'read-only') return
    if (continuationId && (!continuation || !['needs_input', 'blocked'].includes(continuation.stage))) return
    const request: ScheduledCreationRequest = {
      requestId: continuation?.id ?? crypto.randomUUID(), ...(continuation ? { expectedRevision: continuation.revision } : {}),
      message: draft.goal.trim(), modelId: settings.modelId, workDir: settings.workDir.trim(), timezone: continuation?.request.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      permissions: { preset: settings.permissions.preset, approvalMode: settings.permissions.approvalMode ?? 'confirm-each' },
    }
    submitted.current = request
    void model.submitCreation(request)
  }
  const resume = (creation: ScheduledCreation) => {
    if (awaiting) return
    setContinuationId(creation.id)
    setDraft(value => ({ ...value, goal: '', settings: { ...value.settings, workDir: creation.request.workDir, modelId: creation.request.modelId, permissions: { ...creation.request.permissions } } }))
    input.current?.focus({ preventScroll: true })
  }
  const open = (id: string) => workspace.navigate({ name: 'scheduled', taskId: id, view: 'history' })
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
  const creationDefinitions = new Set(data?.creations?.filter(item => item.stage !== 'cancelled').map(item => item.definitionId))
  const pendingDefinitions = groups.pending.filter(item => !creationDefinitions.has(item.id))
  const matches = (item: ScheduledDefinition) => `${item.input.name} ${item.input.goal}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
  const list = (items: ScheduledDefinition[], label: string) => items.length ? <section className="ent-sch-nav-group" aria-label={label}>
    {items.filter(matches).map(item => <button type="button" className="ent-sch-nav-task" aria-current={selectedDefinition?.id === item.id ? 'page' : undefined} key={item.id} onClick={() => workspace.navigate({ name: 'scheduled', taskId: item.id, view: !item.plan && !item.enabled ? 'edit' : 'history' })}>
      <strong>{item.input.name}</strong><span>{recurrenceLabel(item)}</span>
    </button>)}
  </section> : null
  const hasCreations = Boolean(data?.creations?.length || pending.length)
  const missingTask = workspace.route.name === 'scheduled' && workspace.route.taskId && !selectedDefinition
  const home = !selectedDefinition && !missingTask

  return <div className="ent-sch-workspace">
    <aside className="ent-sch-sidebar" aria-label="定时任务导航">
      <header><h2>定时任务</h2><button className="ent-sch-close" type="button" aria-label="搜索定时任务" title="搜索定时任务" aria-expanded={searching} onClick={() => { setSearching(value => !value); setSearch('') }}><Search size={17} /></button></header>
      {searching ? <label className="ent-sch-search"><Search size={14} aria-hidden /><input autoFocus type="search" aria-label="搜索任务名称或内容" value={search} onChange={event => setSearch(event.target.value)} /></label> : null}
      <button type="button" className="ent-sch-nav-new" onClick={focusComposer}><Plus size={18} />新建任务</button>
      <div className="ent-sch-nav-scroll" aria-label="定时任务概览" tabIndex={0}>
        {list(groups.active, '进行中的定时任务')}
        {pendingDefinitions.length ? <><h3>待完成</h3>{list(pendingDefinitions, '待完成的定时任务')}</> : null}
        <details className="ent-sch-nav-fold" open><summary>已暂停<ChevronDown size={14} /><small>{groups.paused.length || ''}</small></summary>{list(groups.paused, '已暂停的定时任务')}</details>
        {groups.history.length ? <details className="ent-sch-nav-fold" open><summary>历史记录<ChevronDown size={14} /><small>{groups.history.length}</small></summary>{list(groups.history, '定时任务历史')}</details> : null}
        {search.trim() && ![...groups.active, ...groups.paused, ...pendingDefinitions, ...groups.history].some(matches) ? <p className="ent-sch-search-empty">没有匹配的任务</p> : null}
        {hasCreations ? <button type="button" className="ent-sch-nav-new" onClick={() => workspace.replaceRoute({ name: 'scheduled' })}>创建进度</button> : null}
      </div>
    </aside>
    <section ref={mainPane} className={`ent-sch-main-pane${home ? ' ent-sch-compose-pane' : ''}`} aria-label="定时任务内容">
      {!home ? <><button type="button" className="ent-btn ghost sm" onClick={() => workspace.replaceRoute({ name: 'scheduled' })}><ArrowLeft size={14} />返回首页</button>{selectedDefinition ? <ScheduledTaskDetail key={selectedDefinition.id} definition={selectedDefinition} workspace={workspace} model={model} /> : <p role="status">未找到这项任务，请返回首页。</p>}</> : <>
      <div className="ent-sch-home-content" tabIndex={0} aria-label="定时任务创建区">
        <div className="ent-sch-welcome"><img className="ent-sch-clock" src={scheduledClock} width={80} height={80} alt="" /><h2>安排任务</h2>
        <section className="ent-sch-examples" aria-label="定时任务示例"><h3>常用任务</h3>
        <div className="ent-sch-home-grid">{SCHEDULE_EXAMPLES.map(example => <button type="button" key={example.id} className="ent-sch-example" aria-label={`使用示例：${example.title}`} disabled={model.busy} onClick={() => selectExample(example)}><span><strong>{example.title}</strong><span>{example.description}</span></span><Plus size={19} aria-hidden /></button>)}</div>
        </section>
        </div>
      <ScheduledCreationList model={model} onResume={resume} onOpen={open} />
      </div>
    <form className="ent-sch-home-compose" onSubmit={event => { event.preventDefault(); submit() }}>
      <div className="ent-sch-home-compose-actions"><button type="button" className="ent-btn ghost sm" onClick={onCreate}>手动设置</button></div>
      {continuation ? <div className="ent-sch-replying"><span>补充：{continuation.interpretation?.task.title ?? continuation.request.message}</span><button type="button" aria-label="退出补充" title="退出补充" disabled={awaiting} onClick={() => { setContinuationId(null); setDraft(value => ({ ...value, goal: '' })) }}><X size={14} /></button></div> : null}
      <fieldset ref={composer} disabled={sending} className="ent-sch-composer">
        <label className="sr-only" htmlFor="schedule-home-goal">定时任务工作内容</label><textarea id="schedule-home-goal" ref={input} rows={2} value={draft.goal} maxLength={16000} placeholder={continuation ? '补充缺少的信息…' : '安排一项定期完成的工作…'} onChange={event => setDraft(value => ({ ...value, goal: event.target.value }))} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); submit() } }} />
        <ScheduledExecutionFields naturalLanguage value={{ ...draft, settings }} employees={workspace.myEmployees} onChange={patch => setDraft(value => ({ ...value, ...patch, settings: { ...value.settings, ...patch.settings } }))} action={<button type="submit" className="ent-sch-home-send" aria-label={continuation ? '发送补充信息' : '创建并启用定时任务'} title={continuation ? '发送补充信息' : '创建并启用'} disabled={awaiting || !draft.goal.trim() || !settings.workDir.trim() || !models.includes(settings.modelId)}><ArrowUp size={19} aria-hidden /></button>} onChooseFolder={async path => {
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
