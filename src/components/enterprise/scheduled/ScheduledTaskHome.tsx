import { useEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowRight, ArrowUp, Plus, X } from 'lucide-react'
import type { ScheduledDefinition, ScheduledOccurrence } from '../../../shared/scheduled-tasks'
import type { EnterpriseWorkspace } from '../../../features/enterprise/useEnterpriseWorkspace'
import type { ScheduledTasksModel } from '../../../features/enterprise/use-scheduled-tasks'
import { recurrenceLabel, RUN_LABELS, scheduledHomeGroups, scheduleTime, TERMINAL_RUNS } from '../../../features/enterprise/scheduled-task-model'
import { authorizedScheduledModels, emptyScheduledTaskDraft, SCHEDULE_EXAMPLES } from '../../../features/enterprise/scheduled-task-home'
import type { ScheduledCreation, ScheduledCreationRequest } from '../../../shared/scheduled-creation'
import { creationAccepted } from '../../../features/enterprise/scheduled-task-client'
import { EmployeeFace } from '../EmployeeFace'
import { ScheduledExecutionFields } from './ScheduledExecutionFields'
import { ScheduledCreationList } from './ScheduledCreationList'

interface Props { workspace: EnterpriseWorkspace; model: ScheduledTasksModel }
type Example = typeof SCHEDULE_EXAMPLES[number]

export function ScheduledTaskHome({ workspace, model }: Props) {
  const [draft, setDraft] = useState(emptyScheduledTaskDraft)
  const [replacement, setReplacement] = useState<Example | null>(null)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)
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
  const runs = useMemo(() => {
    const latest = new Map<string, ScheduledOccurrence>()
    for (const run of data?.occurrences ?? []) {
      const previous = latest.get(run.definitionId)
      if (!previous || (!TERMINAL_RUNS.has(run.status) && TERMINAL_RUNS.has(previous.status)) || (TERMINAL_RUNS.has(run.status) === TERMINAL_RUNS.has(previous.status) && run.scheduledAt > previous.scheduledAt)) latest.set(run.definitionId, run)
    }
    return latest
  }, [data])
  const employees = useMemo(() => new Map(workspace.myEmployees.map(item => [item.id, item])), [workspace.myEmployees])
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
  const creationDefinitions = new Set(data?.creations?.filter(item => item.stage !== 'cancelled').map(item => item.definitionId))
  const pendingDefinitions = groups.pending.filter(item => !creationDefinitions.has(item.id))
  const group = (items: ScheduledDefinition[], paused: boolean) => items.length ? <section className="ent-sch-home-section" aria-label={paused ? '已暂停的定时任务' : '进行中的定时任务'}>
    <h3>{paused ? '已暂停' : '进行中'}<small>{items.length}</small></h3>
    <div className="ent-sch-home-grid">{items.map(item => {
      const run = runs.get(item.id)
      const employee = employees.get(item.input.subscriptionId)
      const unfinished = run && !TERMINAL_RUNS.has(run.status)
      const label = unfinished ? RUN_LABELS[run.status] : paused ? '已暂停' : run?.status === 'failed' || run?.status === 'timed_out' ? `最近${RUN_LABELS[run.status]}` : '等待下次运行'
      return <button type="button" className="ent-sch-task-card" key={item.id} onClick={() => workspace.navigate({ name: 'scheduled', taskId: item.id, view: 'history' })}>
        <span className="ent-sch-task-card-title"><strong>{item.input.name}</strong><span className={`ent-sch-status ${unfinished || (!paused && (run?.status === 'failed' || run?.status === 'timed_out')) ? run?.status : ''}`}>{label}</span></span>
        <span className="ent-sch-task-card-goal">{item.input.goal}</span>
        <span className="ent-sch-task-card-person"><EmployeeFace employee={employee} size="sm" round /><span>{item.input.mode === 'auto' ? '自动编排' : employee?.name ?? '员工暂不可用'}</span></span>
        <span className="ent-sch-task-card-footer"><span>{recurrenceLabel(item)}</span>{!paused && item.nextRunAt !== null ? <span>下次 {scheduleTime(item.nextRunAt, item.input.timezone)}</span> : null}</span>
      </button>
    })}</div>
  </section> : null

  return <div className="ent-sch-home">
    <div className="ent-sch-home-scroll" tabIndex={0} aria-label="定时任务概览">
      <ScheduledCreationList model={model} onResume={resume} onOpen={open} />
      {group(groups.active, false)}
      {group(groups.paused, true)}
      {pendingDefinitions.length ? <section className="ent-sch-home-section ent-sch-home-compact" aria-label="待完成的定时任务"><h3>待完成<small>{pendingDefinitions.length}</small></h3>{pendingDefinitions.map(item => <button type="button" key={item.id} onClick={() => workspace.navigate({ name: 'scheduled', taskId: item.id, view: item.plan ? 'configuration' : 'edit' })}><strong>{item.input.name}</strong><span>继续设置<ArrowRight size={14} /></span></button>)}</section> : null}
      {groups.history.length ? <section className="ent-sch-home-section ent-sch-home-compact" aria-label="定时任务历史"><h3>历史记录<small>{groups.history.length}</small></h3>{groups.history.map(item => <button type="button" key={item.id} onClick={() => open(item.id)}><strong>{item.input.name}</strong><span>{item.deleted ? '已归档' : runs.get(item.id) ? RUN_LABELS[runs.get(item.id)!.status] : '执行记录'}<ArrowRight size={14} /></span></button>)}</section> : null}
      <section className="ent-sch-home-section ent-sch-examples" aria-label="定时任务示例"><h3>为你推荐</h3>
        <div className="ent-sch-home-grid">{SCHEDULE_EXAMPLES.map(example => <button type="button" key={example.id} className="ent-sch-example" aria-label={`使用示例：${example.title}`} disabled={model.busy} onClick={() => selectExample(example)}><span><strong>{example.title}</strong><span>{example.description}</span></span><Plus size={19} aria-hidden /></button>)}</div>
      </section>
    </div>
    <form className="ent-sch-home-compose" onSubmit={event => { event.preventDefault(); submit() }}>
      {continuation ? <div className="ent-sch-replying"><span>补充：{continuation.interpretation?.task.title ?? continuation.request.message}</span><button type="button" aria-label="退出补充" title="退出补充" disabled={awaiting} onClick={() => { setContinuationId(null); setDraft(value => ({ ...value, goal: '' })) }}><X size={14} /></button></div> : null}
      <fieldset disabled={sending} className="ent-sch-composer">
        <label className="sr-only" htmlFor="schedule-home-goal">定时任务工作内容</label><textarea id="schedule-home-goal" ref={input} rows={2} value={draft.goal} maxLength={16000} placeholder={continuation ? '补充缺少的信息…' : '安排一项定期完成的工作…'} onChange={event => setDraft(value => ({ ...value, goal: event.target.value }))} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); submit() } }} />
        <ScheduledExecutionFields naturalLanguage value={{ ...draft, settings }} employees={workspace.myEmployees} onChange={patch => setDraft(value => ({ ...value, ...patch, settings: { ...value.settings, ...patch.settings } }))} action={<button type="submit" className="ent-sch-home-send" aria-label={continuation ? '发送补充信息' : '创建并启用定时任务'} title={continuation ? '发送补充信息' : '创建并启用'} disabled={awaiting || !draft.goal.trim() || !settings.workDir.trim() || !models.includes(settings.modelId)}><ArrowUp size={19} aria-hidden /></button>} onChooseFolder={async path => {
          try { const chosen = await workspace.chooseFolder(path); setError(null); return chosen }
          catch { setError('无法选择目录，请重试。'); return null }
        }} />
      </fieldset>
      {error ? <p role="alert" className="ent-sch-modal-error">{error}</p> : null}
    </form>
    <Dialog.Root open={replacement !== null} onOpenChange={open => { if (!open) setReplacement(null) }}><Dialog.Portal container={container}><Dialog.Overlay className="ent-sch-modal-overlay" /><Dialog.Content role="alertdialog" className="ent-sch-replace-dialog" onCloseAutoFocus={event => { event.preventDefault(); input.current?.focus({ preventScroll: true }) }}><Dialog.Title>替换当前内容？</Dialog.Title><Dialog.Description>当前内容已编辑，使用新示例会替换工作内容，其他设置保持不变。</Dialog.Description><footer><Dialog.Close asChild><button type="button" className="ent-btn">保留内容</button></Dialog.Close><button type="button" className="ent-btn primary" onClick={() => { if (replacement) applyExample(replacement) }}>替换内容</button></footer></Dialog.Content></Dialog.Portal></Dialog.Root>
  </div>
}
