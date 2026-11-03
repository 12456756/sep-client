import { Users, UserRound } from 'lucide-react'
import type { ReactNode } from 'react'
import type { SiliconEmployee } from '../../../features/enterprise/types'
import { authorizedScheduledModels, automaticPlanningSelection, type ScheduledTaskDraft } from '../../../features/enterprise/scheduled-task-home'
import { RunSettingsBar, RunSettingsDirectory } from '../arrange/RunSettingsDrawer'

interface Props {
  value: ScheduledTaskDraft
  employees: SiliconEmployee[]
  onChange(patch: Partial<Pick<ScheduledTaskDraft, 'mode' | 'subscriptionId'>> & { settings?: Partial<ScheduledTaskDraft['settings']> }): void
  onChooseFolder(path?: string): Promise<string | null>
  action?: ReactNode
  naturalLanguage?: boolean
}

export function ScheduledExecutionFields({ value, employees, onChange, onChooseFolder, action, naturalLanguage = false }: Props) {
  const available = employees.filter(item => item.assignedToMe && !['unavailable', 'needs-auth'].includes(item.availability))
  const employee = available.find(item => item.id === value.subscriptionId)
  const automatic = value.mode === 'auto'
  const models = naturalLanguage ? authorizedScheduledModels(employees) : automatic ? [...new Set(available.flatMap(item => item.allowedModels))] : employee?.allowedModels ?? []
  const onSettings = (patch: Partial<ScheduledTaskDraft['settings']>) => {
    if (!naturalLanguage && automatic && patch.modelId !== undefined) {
      const selection = automaticPlanningSelection(available, patch.modelId, value.subscriptionId)
      onChange({ subscriptionId: selection.subscriptionId, settings: { ...patch, modelId: selection.modelId } })
    } else onChange({ settings: patch })
  }
  return <>
    <div className="ent-sch-composer-tools">
      <div className="ent-sch-execution-selects">
        {!naturalLanguage ? <label className="ent-rs-compact ent-sch-mode" title="执行方式">{automatic ? <Users size={16} /> : <UserRound size={16} />}<select aria-label="任务模式" value={value.mode} onChange={event => {
          const mode = event.target.value as ScheduledTaskDraft['mode']
          if (mode === 'auto') {
            const selection = automaticPlanningSelection(available, value.settings.modelId, value.subscriptionId)
            onChange({ mode, subscriptionId: selection.subscriptionId, settings: { modelId: selection.modelId } })
          } else onChange({ mode })
        }}><option value="employee">指定员工</option><option value="auto">自动编排</option></select></label> : null}
        {!naturalLanguage && !automatic ? <label className="ent-rs-compact ent-sch-employee"><select aria-label="执行员工" value={value.subscriptionId} onChange={event => {
          const selected = available.find(item => item.id === event.target.value)
          onChange({ subscriptionId: event.target.value, settings: { modelId: selected?.allowedModels[0] ?? '' } })
        }}><option value="">选择员工</option>{value.subscriptionId && !available.some(item => item.id === value.subscriptionId) ? <option value={value.subscriptionId}>原员工暂不可用</option> : null}{available.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : null}
        <RunSettingsBar settings={value.settings} models={models} onChange={onSettings} portalWithinControl />
      </div>
      {action}
    </div>
    <div className="ent-sch-composer-environment"><RunSettingsDirectory settings={value.settings} onChange={onSettings} allowedPresets={['workspace-edit', 'full-local']} onChooseFolder={onChooseFolder} /></div>
  </>
}
