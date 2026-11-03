import { useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ScheduledDefinition } from '../../../shared/scheduled-tasks'
import { scheduleInputSchema } from '../../../shared/scheduled-tasks'
import type { EnterpriseWorkspace } from '../../../features/enterprise/useEnterpriseWorkspace'
import type { ScheduledTasksModel } from '../../../features/enterprise/use-scheduled-tasks'
import { initialTiming, timingConfiguration } from '../../../features/enterprise/scheduled-time-form'
import { defaultRunSettings, type RunSettings } from '../../../features/enterprise/run-settings'
import type { ScheduledTaskDraft } from '../../../features/enterprise/scheduled-task-home'
import { ScheduledExecutionFields } from './ScheduledExecutionFields'
import { ScheduledTimeSettings } from './ScheduledTimeSettings'

interface Props { definition?: ScheduledDefinition; initialDraft?: ScheduledTaskDraft; workspace: EnterpriseWorkspace; model: ScheduledTasksModel }

export function ScheduledTaskEditor(props: Props) {
  const [parsing, setParsing] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const [container] = useState(() => typeof document === 'undefined' ? undefined : document.querySelector<HTMLElement>('.ent-shell') ?? undefined)
  const close = () => props.workspace.replaceRoute(props.definition ? { name: 'scheduled', taskId: props.definition.id, view: 'configuration' } : { name: 'scheduled' })
  const busy = props.model.busy || parsing
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) close() }}>
    <Dialog.Portal container={container}><Dialog.Overlay className="ent-sch-modal-overlay" /><Dialog.Content ref={panel} className="ent-sch-modal" aria-describedby={undefined} onOpenAutoFocus={event => { event.preventDefault(); panel.current?.querySelector<HTMLInputElement>('.ent-sch-title-input')?.focus() }} onPointerDownOutside={event => event.preventDefault()} onEscapeKeyDown={event => { if (busy || panel.current?.querySelector('.ent-model-trigger[aria-expanded="true"]')) event.preventDefault() }}>
      <Dialog.Title className="sr-only">{props.definition ? '编辑定时任务' : '新建定时任务'}</Dialog.Title>
      <ScheduledTaskEditorForm {...props} onClose={close} parsing={parsing} onParsingChange={setParsing} />
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>
}

export function ScheduledTaskEditorForm({ definition, initialDraft, workspace, model, onClose, parsing = false, onParsingChange = () => {} }: Props & { onClose(): void; parsing?: boolean; onParsingChange?(value: boolean): void }) {
  // Freeze the revision so polling cannot silently replace the draft during editing.
  const [original] = useState(definition)
  const [requestId] = useState(() => crypto.randomUUID())
  const saved = useRef(original)
  const submitting = useRef(false)
  const [name, setName] = useState(original?.input.name ?? '')
  const prefill = original ? undefined : initialDraft
  const [goal, setGoal] = useState(original?.input.goal ?? prefill?.goal ?? '')
  const [mode, setMode] = useState<'employee' | 'auto'>(original?.input.mode ?? prefill?.mode ?? 'employee')
  const [employeeId, setEmployeeId] = useState(original?.input.subscriptionId ?? prefill?.subscriptionId ?? '')
  const [timing, setTiming] = useState(() => initialTiming(original?.input))
  const [settings, setSettings] = useState<RunSettings>(() => ({ ...defaultRunSettings(), workDir: original?.input.workDir ?? prefill?.settings.workDir ?? '', modelId: original?.input.modelId ?? prefill?.settings.modelId ?? '', permissions: original?.input.permissions ?? prefill?.settings.permissions ?? { preset: 'workspace-edit', approvalMode: 'confirm-each' } }))
  const [error, setError] = useState<string | null>(null)
  const employee = workspace.myEmployees.find(item => item.id === employeeId)
  const available = workspace.myEmployees.filter(item => item.assignedToMe && !['unavailable', 'needs-auth'].includes(item.availability))
  const busy = model.busy || parsing
  const submit = async () => {
    if (submitting.current || busy) return
    setError(null)
    let configuration: ReturnType<typeof timingConfiguration>
    try { configuration = timingConfiguration(timing) }
    catch (failure) { setError(failure instanceof Error ? failure.message : '时间配置无效。'); return }
    if (!available.some(item => item.id === employeeId) || !employee?.allowedModels.includes(settings.modelId)) { setError('请选择可用的员工及其允许使用的模型。'); return }
    const { scheduledAt, recurrence } = configuration
    const input = scheduleInputSchema.safeParse({ mode, name, goal, subscriptionId: employeeId, modelId: settings.modelId, workDir: settings.workDir, permissions: settings.permissions, scheduledAt, timezone: timing.timezone, recurrence })
    if (!input.success) { setError('请填写标题和工作内容，并选择工作目录、模型及有效时间。'); return }
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
        <label className="sr-only" htmlFor="scheduled-goal">工作目标</label><textarea id="scheduled-goal" value={goal} maxLength={16000} required rows={5} onChange={event => setGoal(event.target.value)} placeholder="描述员工应该做什么，以及需要交付的文件或结果" />
        <ScheduledExecutionFields value={{ goal, mode, subscriptionId: employeeId, settings }} employees={workspace.myEmployees} onChange={patch => { if (patch.mode) setMode(patch.mode); if (patch.subscriptionId !== undefined) setEmployeeId(patch.subscriptionId); if (patch.settings) setSettings(value => ({ ...value, ...patch.settings })) }} onChooseFolder={async path => { try { return await workspace.chooseFolder(path) } catch { setError('无法选择目录，请重试。'); return null } }} />
      </div>
      {!available.length ? <p className="ent-sch-modal-error" role="status">当前没有可用员工，请先检查员工授权。</p> : null}
      {settings.permissions.approvalMode === 'auto-approve' ? <p className="ent-sch-permission-warning">工具操作将按所选权限自动放行。{settings.permissions.preset === 'full-local' ? '完整本地权限可访问工作目录以外的文件。' : ''}</p> : null}
      <ScheduledTimeSettings value={timing} onChange={setTiming} employeeId={employeeId} modelId={settings.modelId} model={model} onParsingChange={onParsingChange} />
    </fieldset>
    {error || model.error ? <p className="ent-sch-modal-error" role="alert">{error || model.error}</p> : null}</div>
    <footer><button type="button" className="ent-btn" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="ent-btn primary" disabled={busy || !name.trim() || !goal.trim() || !employeeId || !settings.workDir || !settings.modelId}>{model.busy ? '正在保存…' : '保存'}</button></footer>
  </form>
}
