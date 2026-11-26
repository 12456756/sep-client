import { useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ScheduledDefinition } from '../../../shared/scheduled-tasks'
import { retiredScheduledExecutionMessage, scheduleInputSchema, scheduledGeneralUnavailable } from '../../../shared/scheduled-tasks'
import type { EnterpriseWorkspace } from '../../../features/enterprise/useEnterpriseWorkspace'
import type { ScheduledTasksModel } from '../../../features/enterprise/use-scheduled-tasks'
import { initialTiming, timingConfiguration } from '../../../features/enterprise/scheduled-time-form'
import { defaultRunSettings, type RunSettings } from '../../../features/enterprise/run-settings'
import { authorizedScheduledModels, type ScheduledTaskDraft } from '../../../features/enterprise/scheduled-task-home'
import { useModelPreference } from '../../workspace/model-preference-scope'
import { resolveTaskModel } from '../../../shared/model-preferences'
import { ScheduledExecutionFields } from './ScheduledExecutionFields'
import { ScheduledTimeSettings } from './ScheduledTimeSettings'
import { ComposerResizeHandle } from '../ComposerResizeHandle'

interface Props { definition?: ScheduledDefinition; initialDraft?: ScheduledTaskDraft; workspace: EnterpriseWorkspace; model: ScheduledTasksModel }

export function ScheduledTaskEditor(props: Props) {
  const [parsing, setParsing] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const [container] = useState(() => typeof document === 'undefined' ? undefined : document.querySelector<HTMLElement>('.ent-shell') ?? undefined)
  const close = () => props.workspace.replaceRoute(props.definition ? { name: 'scheduled', taskId: props.definition.id, view: 'configuration' } : { name: 'scheduled' })
  const busy = props.model.busy || parsing
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) close() }}>
    <Dialog.Portal container={container}><Dialog.Overlay className="ent-sch-modal-overlay" /><Dialog.Content ref={panel} className="ent-sch-modal" aria-describedby={undefined} onOpenAutoFocus={event => { event.preventDefault(); panel.current?.querySelector<HTMLInputElement>('.ent-sch-title-input')?.focus() }} onPointerDownOutside={event => event.preventDefault()} onEscapeKeyDown={event => { if (busy || panel.current?.querySelector(':is(.ent-model-trigger, .ent-chat-whobtn)[aria-expanded="true"]')) event.preventDefault() }}>
      <Dialog.Title className="sr-only">{props.definition ? '编辑定时任务' : '新建定时任务'}</Dialog.Title>
      <ScheduledTaskEditorForm {...props} onClose={close} parsing={parsing} onParsingChange={setParsing} />
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>
}

export function ScheduledTaskEditorForm({ definition, initialDraft, workspace, model, onClose, parsing = false, onParsingChange = () => {} }: Props & { onClose(): void; parsing?: boolean; onParsingChange?(value: boolean): void }) {
  const input = useRef<HTMLTextAreaElement>(null)
  // Freeze the revision so polling cannot silently replace the draft during editing.
  const [original] = useState(definition)
  const [requestId] = useState(() => crypto.randomUUID())
  const saved = useRef(original)
  const submitting = useRef(false)
  const [name, setName] = useState(original?.input.name ?? '')
  const prefill = original ? undefined : initialDraft
  const retired = original?.input.mode === 'empty-text' ? original.input.emptyText : undefined
  const [goal, setGoal] = useState(() => {
    if (!retired) return original?.input.goal ?? prefill?.goal ?? ''
    const filename = retired.naming === 'fixed' ? retired.filename : `按${retired.naming === 'started' ? '启动' : '计划'}时间命名（yyyyMMdd-HHmm.txt）`
    return `创建一个 0 字节的空白 .txt 文件：${filename}。不得覆盖已有文件。`
  })
  const [mode, setMode] = useState<ScheduledTaskDraft['mode']>(original && original.input.mode !== 'empty-text' ? original.input.mode ?? 'employee' : prefill?.mode === 'employee' || prefill?.mode === 'auto' ? prefill.mode : 'general')
  const [employeeId, setEmployeeId] = useState(original?.input.subscriptionId ?? prefill?.subscriptionId ?? '')
  const [timing, setTiming] = useState(() => initialTiming(original?.input))
  const [draftSettings, setSettings] = useState<RunSettings>(() => ({ ...defaultRunSettings(), workDir: original?.input.workDir ?? prefill?.settings.workDir ?? '', modelId: original?.input.modelId ?? prefill?.settings.modelId ?? '', permissions: original?.input.permissions ?? prefill?.settings.permissions ?? { preset: 'workspace-edit', approvalMode: 'confirm-each' } }))
  const [error, setError] = useState<string | null>(null)
  const [outputDirectory, setOutputDirectory] = useState(original?.input.outputDirectory?.path ?? '')
  const employee = workspace.myEmployees.find(item => item.id === employeeId)
  const available = workspace.myEmployees.filter(item => item.assignedToMe && !['unavailable', 'needs-auth'].includes(item.availability))
  const general = mode === 'general'
  const { defaultModelId } = useModelPreference()
  const generalModels = authorizedScheduledModels(available)
  const settings = general && !draftSettings.modelId ? { ...draftSettings, modelId: resolveTaskModel(generalModels, defaultModelId) } : draftSettings
  const generalUnavailable = general && !generalModels.includes(settings.modelId)

  const busy = model.busy || parsing
  const submit = async () => {
    if (submitting.current || busy) return
    setError(null)
    let configuration: ReturnType<typeof timingConfiguration>
    try { configuration = timingConfiguration(timing) }
    catch (failure) { setError(failure instanceof Error ? failure.message : '时间配置无效。'); return }
    if (generalUnavailable) { setError(scheduledGeneralUnavailable); return }
    if (!general && (!available.some(item => item.id === employeeId) || !employee?.allowedModels.includes(settings.modelId))) { setError('请选择可用的员工及其允许使用的模型。'); return }
    const { scheduledAt, recurrence } = configuration
    const base = { mode, name, workDir: settings.workDir, scheduledAt, timezone: timing.timezone, recurrence,
      ...(outputDirectory ? { outputDirectory: { path: outputDirectory } } : {}) }
    const input = scheduleInputSchema.safeParse({ ...base, goal, permissions: { preset: 'workspace-edit', approvalMode: 'confirm-each' }, modelId: settings.modelId, ...(general ? {} : { subscriptionId: employeeId }) })
    if (!input.success) { setError('请检查标题、工作目录、执行设置和时间。'); return }
    submitting.current = true
    try {
      const result = await model.save(requestId, input.data, saved.current)
      if (result?.success && result.data) {
        saved.current = result.data
        workspace.replaceRoute({ name: 'scheduled', taskId: result.data.id, view: 'configuration' })
      }
    } finally { submitting.current = false }
  }

  return <form className="ent-sch-editor" onSubmit={event => { event.preventDefault(); void submit() }}>
    <header><h2>{original ? '编辑定时任务' : '新建定时任务'}</h2><button type="button" className="ent-sch-close" title="关闭" aria-label="关闭定时任务弹窗" disabled={busy} onClick={onClose}><X size={19} /></button></header>
    <div className="ent-sch-editor-body"><fieldset disabled={busy}>
      <label className="sr-only" htmlFor="scheduled-title">任务名称</label><input id="scheduled-title" className="ent-sch-title-input" value={name} maxLength={160} required onChange={event => setName(event.target.value)} placeholder="定时任务标题" />
      <div className="ent-sch-composer">
        <label className="sr-only" htmlFor="scheduled-goal">工作目标</label><textarea id="scheduled-goal" ref={input} value={goal} maxLength={16000} required rows={5} onChange={event => setGoal(event.target.value)} placeholder="描述要完成的工作及需要交付的文件" />
        <ScheduledExecutionFields value={{ goal, mode, subscriptionId: employeeId, settings }} employees={workspace.myEmployees} onChange={patch => { if (patch.mode) setMode(patch.mode); if (patch.subscriptionId !== undefined) setEmployeeId(patch.subscriptionId); if (patch.settings) setSettings(value => ({ ...value, ...patch.settings })) }} action={<ComposerResizeHandle inputRef={input} />} onChooseFolder={async path => { try { return await workspace.chooseFolder(path) } catch { setError('无法选择目录，请重试。'); return null } }} />
      </div>
      {retired && <p className="ent-sch-help">{retiredScheduledExecutionMessage}</p>}
      {original?.input.actions?.length ? <p className="ent-sch-help">旧版附加发送已停用。请将仍需发送的对象和正文写入工作目标。</p> : null}
      {(generalUnavailable || !available.length) ? <p className="ent-sch-modal-error" role="status">{general ? scheduledGeneralUnavailable : '当前没有可用员工，请先检查员工授权。'}</p> : null}
      <div className="ent-sch-time-row"><span>产出目录</span><button type="button" className="ent-btn" onClick={() => void workspace.chooseFolder(outputDirectory || settings.workDir).then(path => { if (path) setOutputDirectory(path) }, () => setError('无法选择产出目录。'))}>{outputDirectory || '选择产出目录'}</button>
        {outputDirectory && <button type="button" className="ent-btn" onClick={() => setOutputDirectory('')}>清除</button>}</div>
      <ScheduledTimeSettings value={timing} onChange={setTiming} employeeId={employeeId} modelId={settings.modelId} model={model} allowTimeInterpretation={!general} onParsingChange={onParsingChange} />
    </fieldset>
    {original && <p className="ent-sch-help">保存后任务不会自动调度，请在任务配置中确认计划并启用。</p>}
    {error || model.error ? <p className="ent-sch-modal-error" role="alert">{error || model.error}</p> : null}</div>
    <footer><button type="button" className="ent-btn" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="ent-btn primary" disabled={busy || generalUnavailable || !name.trim() || !settings.workDir || (!goal.trim() || (!general && !employeeId) || !settings.modelId)}>{model.busy ? '正在保存…' : '保存'}</button></footer>
  </form>
}
