import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { LoaderCircle, X } from 'lucide-react'
import type { ElectronAPI } from '../../../shared/ipc'
import { createWorkScheduleSchema, scheduleTimeResultSchema, workScheduleContextSchema, type CreateWorkSchedule, type ScheduledDefinition, type WorkScheduleContext } from '../../../shared/scheduled-tasks'
import { scheduledDefinitionSchema } from '../../../features/enterprise/scheduled-task-client'
import { initialTiming, timingConfiguration, tomorrowTiming } from '../../../features/enterprise/scheduled-time-form'
import { clearPendingWorkSchedule, readPendingWorkSchedule, retainWorkSchedule } from '../../../features/enterprise/work-schedule-pending'
import { ScheduledTimeSettings } from './ScheduledTimeSettings'

interface Props {
  source?: { id: string; title: string }
  definition?: ScheduledDefinition
  scopeKey: string
  api?: ElectronAPI
  onClose(): void
  onCreated(definition: ScheduledDefinition): void
}

export function WorkScheduleDialog({ source, definition, scopeKey, api = window.electronAPI, onClose, onCreated }: Props) {
  const [original] = useState(definition)
  const [pending, setPending] = useState(() => source ? readPendingWorkSchedule(api, scopeKey, source.id) : undefined)
  const [requestId] = useState(() => pending?.requestId ?? crypto.randomUUID())
  const [name, setName] = useState(pending?.name ?? original?.input.name ?? source?.title ?? '')
  const [timing, setTiming] = useState(() => pending ? initialTiming(pending) : original ? initialTiming(original.input) : tomorrowTiming())
  const [context, setContext] = useState<WorkScheduleContext | null>(null)
  const [loading, setLoading] = useState(Boolean(source && !pending))
  const [sending, setSending] = useState(false)
  const [parsing, setParsing] = useState(false)
  const [error, setError] = useState<string | null>(pending ? '上次保存结果尚未确认，请重试原请求，不会重复创建。' : null)
  const [container] = useState(() => document.querySelector<HTMLElement>('.ent-shell') ?? undefined)
  const active = useRef(true), submitting = useRef(false)
  const titleInput = useRef<HTMLInputElement>(null)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(() => {
    let disposed = false
    if (!source || pending) return
    setLoading(true)
    void api.getScheduledWorkSource(source.id).then(result => {
      if (disposed) return
      if (!result.success) throw new Error(result.error?.message ?? '无法读取原工作计划。')
      const data = workScheduleContextSchema.parse(result.data)
      if (data.taskId !== source.id) throw new Error('工作计划不匹配，请重新打开。')
      setContext(data); setError(null)
    }).catch((failure: unknown) => { if (!disposed) setError(failure instanceof Error ? failure.message : '无法读取原工作计划。') })
      .finally(() => { if (!disposed) setLoading(false) })
    return () => { disposed = true }
  }, [api, source, pending])
  const busy = sending || parsing
  const submit = async () => {
    if (busy || submitting.current || loading) return
    let request: CreateWorkSchedule | undefined = pending
    try {
      const configuration = pending ?? timingConfiguration(timing)
      if (!original && !request) {
        if (!source || !context) throw new Error('原工作计划尚未就绪，请重新打开弹窗。')
        request = createWorkScheduleSchema.parse({ requestId, taskId: source.id, expectedPlanHash: context.planHash, name, scheduledAt: configuration.scheduledAt, recurrence: configuration.recurrence, timezone: timing.timezone })
        retainWorkSchedule(api, scopeKey, request)
        setPending(request)
      }
      submitting.current = true; setSending(true); setError(null)
      const result = original
        ? await api.editScheduledTaskFromWork({ id: original.id, expectedRevision: original.revision, name, scheduledAt: configuration.scheduledAt, recurrence: configuration.recurrence, timezone: timing.timezone })
        : await api.createScheduledTaskFromWork(request!)
      if (!active.current) return
      if (!result.success) {
        if (source && ['INVALID_ARGUMENT', 'DRAFT_REVISION_CONFLICT', 'AUTH_REQUIRED', 'EMPLOYEE_UNAVAILABLE', 'MODEL_NOT_ALLOWED', 'PERMISSION_DENIED', 'WORKSPACE_INVALID'].includes(result.error?.code ?? '')) {
          clearPendingWorkSchedule(api, scopeKey, source.id); setPending(undefined)
        }
        setError(result.error?.message ?? '保存未完成，请检查后重试。')
        return
      }
      const saved = scheduledDefinitionSchema.parse(result.data)
      if (source) clearPendingWorkSchedule(api, scopeKey, source.id)
      onCreated(saved)
    } catch (failure) {
      if (active.current) setError(request ? '保存结果尚未确认。请重试原请求，系统会核对已有记录，不会重复创建。' : failure instanceof Error ? failure.message : '保存未完成，请重试。')
    } finally { submitting.current = false; if (active.current) setSending(false) }
  }
  const timeModel = { interpretTime: async (input: Parameters<ElectronAPI['interpretScheduleTime']>[0]) => {
    const result = await api.interpretScheduleTime(input)
    if (!result.success) throw new Error(result.error?.message ?? '时间解析失败。')
    return scheduleTimeResultSchema.parse(result.data)
  } }
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <Dialog.Portal container={container}><Dialog.Overlay className="ent-sch-modal-overlay" /><Dialog.Content className="ent-sch-modal ent-sch-work-modal" aria-describedby={undefined} onOpenAutoFocus={event => { if (titleInput.current && !titleInput.current.disabled) { event.preventDefault(); titleInput.current.focus() } }} onPointerDownOutside={event => event.preventDefault()} onEscapeKeyDown={event => { if (busy) event.preventDefault() }}>
      <Dialog.Title className="sr-only">{original ? '编辑定时任务' : '加入定时任务'}</Dialog.Title>
      <form className="ent-sch-editor" onSubmit={event => { event.preventDefault(); void submit() }}>
        <header><h2>{original ? '编辑定时任务' : '加入定时任务'}</h2><button type="button" className="ent-sch-close" aria-label="关闭定时任务弹窗" title="关闭" disabled={busy} onClick={onClose}><X size={19} /></button></header>
        <div className="ent-sch-editor-body"><fieldset disabled={busy || loading || Boolean(pending)}>
          <label className="sr-only" htmlFor="work-schedule-title">任务标题</label><input ref={titleInput} id="work-schedule-title" className="ent-sch-title-input" aria-label="任务标题" required maxLength={160} value={name} onChange={event => setName(event.target.value)} placeholder="定时任务标题" />
          <ScheduledTimeSettings value={timing} onChange={setTiming} employeeId={original?.input.subscriptionId ?? context?.subscriptionId ?? ''} modelId={original?.input.modelId ?? context?.modelId ?? ''} model={timeModel} onParsingChange={setParsing} />
        </fieldset>{loading ? <p role="status">正在读取工作计划…</p> : null}{error ? <p role="alert" className="ent-sch-modal-error">{error}</p> : null}</div>
        <footer><button type="button" className="ent-btn" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="ent-btn primary" disabled={busy || loading || !name.trim() || (!original && !context && !pending)}>{sending ? <LoaderCircle size={15} className="ent-sch-spin" /> : null}{sending ? '正在保存…' : pending ? '核对并重试' : original ? '保存并启用' : '创建并启用'}</button></footer>
      </form>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>
}
