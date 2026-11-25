import { Users, UserRound } from 'lucide-react'
import type { ReactNode } from 'react'
import type { SiliconEmployee } from '../../../features/enterprise/types'
import { authorizedScheduledModels, automaticPlanningSelection, type ScheduledTaskDraft } from '../../../features/enterprise/scheduled-task-home'
import { RunSettingsBar, RunSettingsDirectory } from '../arrange/RunSettingsDrawer'
import { useModelPreference } from '../../workspace/model-preference-scope'
import { resolveTaskModel } from '../../../shared/model-preferences'
import { ConversationEmployeePicker } from '../ConversationEmployeePicker'
import { generalAssistant, GENERAL_ASSISTANT_ID } from '../../../features/enterprise/general-assistant'

interface Props {
  value: ScheduledTaskDraft
  employees: SiliconEmployee[]
  onChange(patch: Partial<Pick<ScheduledTaskDraft, 'mode' | 'subscriptionId'>> & { settings?: Partial<ScheduledTaskDraft['settings']> }): void
  onChooseFolder(path?: string): Promise<string | null>
  leadingAction?: ReactNode
  action?: ReactNode
  naturalLanguage?: boolean

}

export function ScheduledExecutionFields({ value, employees, onChange, onChooseFolder, leadingAction, action, naturalLanguage = false }: Props) {
  const { defaultModelId } = useModelPreference()
  const available = employees.filter(item => item.assignedToMe && !['unavailable', 'needs-auth'].includes(item.availability))
  const employee = available.find(item => item.id === value.subscriptionId)
  const automatic = value.mode === 'auto'
  const general = value.mode === 'general'
  const models = naturalLanguage || automatic || general ? authorizedScheduledModels(employees) : employee?.allowedModels ?? []
  const onSettings = (patch: Partial<ScheduledTaskDraft['settings']>) => {
    if (!naturalLanguage && automatic && patch.modelId !== undefined) {
      const selection = automaticPlanningSelection(available, patch.modelId, value.subscriptionId)
      onChange({ subscriptionId: selection.subscriptionId, settings: { ...patch, modelId: selection.modelId } })
    } else onChange({ settings: patch })
  }
  const environment = <div className="ent-sch-composer-environment"><RunSettingsDirectory settings={value.settings} onChange={onSettings} allowedPresets={['workspace-edit']} inheritDefaultDirectory onChooseFolder={onChooseFolder} /></div>
  const execution = <div className="ent-sch-execution-selects">
        {!naturalLanguage ? <label className="ent-rs-compact ent-sch-mode" title="执行方式">{automatic ? <Users size={16} /> : <UserRound size={16} />}<select aria-label="任务模式" value={general ? 'employee' : value.mode} onChange={event => {
          const mode = event.target.value as ScheduledTaskDraft['mode']
          if (mode === 'auto') {
            const selection = automaticPlanningSelection(available, value.settings.modelId, value.subscriptionId, defaultModelId)
            onChange({ mode, subscriptionId: selection.subscriptionId, settings: { modelId: selection.modelId } })
          } else onChange({ mode: 'general', subscriptionId: '', settings: { modelId: '' } })
        }}><option value="employee">指定员工</option><option value="auto">多员工编排</option></select></label> : null}
        {!naturalLanguage && !automatic && <ConversationEmployeePicker employees={[generalAssistant([]), ...available]}
          employeeId={general ? GENERAL_ASSISTANT_ID : value.subscriptionId} label="执行员工"
          currentName={!general && value.subscriptionId && !employee ? '原员工暂不可用' : undefined}
          onChange={id => {
            if (id === GENERAL_ASSISTANT_ID) onChange({ mode: 'general', subscriptionId: '', settings: { modelId: '' } })
            else onChange({ mode: 'employee', subscriptionId: id, settings: { modelId: resolveTaskModel(available.find(item => item.id === id)?.allowedModels ?? [], defaultModelId) } })
          }} />}
        <RunSettingsBar settings={value.settings} models={models} onChange={onSettings} portalWithinControl={!naturalLanguage} />
      </div>
  return <>
    <div className={`ent-sch-composer-tools${naturalLanguage ? ' ent-sch-composer-tools-inline' : ''}`}>
      {leadingAction}
      {naturalLanguage ? <div className="ent-sch-composer-settings">{execution}{environment}</div> : execution}
      {action}
    </div>
    {!naturalLanguage ? environment : null}
  </>
}
